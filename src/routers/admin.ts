/**
 * 管理员路由 —— app/routers/admin.py
 *
 * GET  /admin/audit                      审计日志
 * GET  /admin/pending                    待审列表
 * POST /admin/pending/:pending_id/approve
 * POST /admin/pending/:pending_id/reject
 * GET  /admin/users                      用户列表（普通管理员）
 * GET  /admin/platform-config            读取平台连接配置
 * PUT  /admin/platform-config            保存平台连接配置
 * POST /admin/platform/test              连通性探测（SSRF 白名单）
 * GET  /admin/manage/users               用户管理列表（超级管理员）
 * PUT  /admin/manage/users/:user_id/role
 * POST /admin/manage/users/:user_id/reset-password
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { and, asc, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { recordAudit } from '../audit.js';
import { hashPassword, validatePasswordStrength } from '../auth/password.js';
import { isDemoAccount } from '../auth/demo.js';
import {
  HttpError, authenticate, requireAdmin, requireSuperadmin,
} from '../auth/guards.js';
import { getSettings } from '../config/env.js';
import {
  auditLogs,
  exportResults,
  pendingFiles,
  platformConfig,
  users,
  type User,
  type UserRole,
} from '../db/schema.js';
import type { DbSession } from '../db/session.js';
import { upsertGuacUser } from '../integrations/guac.js';
import { probeSshConnection } from '../integrations/ssh-probe.js';
import { WindowsAccountError, syncWindowsUser } from '../integrations/windows-account.js';
import { asRouteSchema } from '../plugins/validator.js';
import {
  auditLogOutSchema,
  exportReviewRequestSchema,
  messageResponseSchema,
  pendingFileOutSchema,
  toAuditLogOut,
  toPendingFileOut,
  toUserAdminOut,
  toUserOut,
  userAdminOutSchema,
  userOutSchema,
} from '../schemas/index.js';
import { getClientIp } from '../security/rate-limit.js';
import { isPrivateAddress } from '../security/ip.js';
import { fileSha256 } from '../services/review.js';
import { readPlatformConfig, savePlatformConfig } from '../services/platform-config.js';

/** 通过 HTTP 可被授予的角色；superadmin 只能由服务器本机 CLI 产生 */
const MANAGEABLE_ROLES: readonly UserRole[] = ['user', 'admin'];

const ROLE_LABEL: Readonly<Record<UserRole, string>> = {
  user: '普通用户',
  admin: '管理员',
  superadmin: '超级管理员',
};

const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0)
    .openapi({ description: '跳过条数' }),
  limit: z.coerce.number().int().min(1).max(500).default(100)
    .openapi({ description: '返回条数上限（最大 500）' }),
});

const auditQuerySchema = paginationSchema.extend({
  action: z.string().optional().openapi({ description: '按操作类型过滤' }),
  user_id: z.coerce.number().int().optional().openapi({ description: '按操作者过滤' }),
});

const pendingQuerySchema = paginationSchema;

const pendingIdParamsSchema = z.object({
  pending_id: z.coerce.number().int().positive().openapi({ description: '待审文件记录 ID' }),
}).strict();

const userIdParamsSchema = z.object({
  user_id: z.coerce.number().int().positive().openapi({ description: '目标用户 ID' }),
}).strict();

/**
 * ⚠️ 全部字段允许空串（Python 的 PlatformConfigRequest 亦如此，默认值 ''）。
 *
 * 这不是校验疏漏：空串在 readPlatformConfig 里是 falsy，会回落到环境变量，
 * 等价于「把该项恢复为默认配置」。加 min(1) 会破坏这个语义，也会让
 * 「普通用户 403」的用例先落到 422（Fastify 先跑 schema 校验再跑 preHandler）。
 */
const platformConfigRequestSchema = z.object({
  host: z.string().default('').openapi({ description: '数据分析 PC 的 SSH 地址' }),
  port: z.number().int().min(1).max(65_535).default(22)
    .openapi({ description: 'SSH 端口' }),
  username: z.string().default('').openapi({ description: 'SSH 登录用户名' }),
  workspace_dir: z.string().default('').openapi({ description: '用户工作区根目录' }),
  output_path: z.string().default('').openapi({ description: '结果输出目录' }),
}).strict();

/** 与请求体同构，但 port 恒有值且带默认值（GET 返回的是已合并环境变量的结果） */
const platformConfigResponseSchema = z.object({
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  workspace_dir: z.string(),
  output_path: z.string(),
});

const platformTestRequestSchema = z.object({
  // Python 的 PlatformTestRequest：host/username 必填但允许空串，password 默认 ''
  host: z.string().openapi({ description: '探测目标主机（仅允许已知主机或内网地址）' }),
  port: z.number().int().min(1).max(65_535).default(22),
  username: z.string(),
  /** 密码仅用于本次探测，永不落库 */
  password: z.string().default(''),
}).strict();

/**
 * { success, message }：平台连通性探测与平台配置保存共用。
 *
 * ⚠️ latency_ms 必须写进 schema：Fastify 用 fast-json-stringify 序列化响应，
 * schema 里没声明的字段会被直接丢弃（Python 没有这个问题，pydantic 默认放行）。
 */
const successResponseSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  latency_ms: z.number().int().optional().openapi({ description: '连接耗时（毫秒），仅连通性探测返回' }),
});

const roleUpdateSchema = z.object({
  role: z.string().min(1).openapi({ description: '目标角色：user / admin（superadmin 只能通过服务器 CLI 授予）' }),
}).strict();

const resetPasswordSchema = z.object({
  new_password: z.string().min(1).openapi({ description: '新密码，需满足强度策略' }),
}).strict();

/**
 * B3 SSRF 防护：只允许探测「已知主机」或私有地址，域名一律拒绝。
 *
 * `db` 为 null 时不查库 —— 与 Python 完全一致：put_platform_config 调用处
 * 没传 db（保存时的白名单不含库中已存的 host），platform/test 才传。
 * 这个不一致是原实现的既有行为，迁移阶段不擅自「修好」它，只做记录。
 */
const isAllowedTestHost = async (db: DbSession | null, host: string): Promise<boolean> => {
  const { sftpHost, rdsHost } = getSettings();
  const known = new Set([sftpHost, rdsHost, 'localhost', '127.0.0.1']);

  if (db !== null) {
    const [row] = await db.db.select().from(platformConfig)
      .where(eq(platformConfig.key, 'host')).limit(1);
    if (row?.value) known.add(row.value);
  }

  if (known.has(host)) return true;
  // 域名返回 false（Python 侧 ipaddress 解析域名抛 ValueError，同样落到 False）
  return isPrivateAddress(host);
};

const publishedDir = async (resultId: number): Promise<string> => {
  const dir = join(getSettings().fileserverRoot, 'published', String(resultId));
  await mkdir(dir, { recursive: true });
  return dir;
};

/** 超级管理员不可通过 HTTP 改动：既不能改其角色，也不能重置其密码 */
const assertNotSuperadmin = (user: User): void => {
  if (user.role === 'superadmin') {
    throw new HttpError(400, '超级管理员账号只能通过服务器本地命令变更，禁止通过接口操作');
  }
};

const adminRoutes: FastifyPluginAsync = async (app) => {
  /* ---------------- 审计日志 ---------------- */

  app.get<{ Querystring: z.infer<typeof auditQuerySchema> }>('/admin/audit', {
    schema: asRouteSchema({
      querystring: auditQuerySchema,
      response: { 200: z.array(auditLogOutSchema) },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const { skip, limit, action, user_id: userId } = request.query;

    return app.withDb(async (db) => {
      const filters = [
        action ? eq(auditLogs.action, action) : undefined,
        userId !== undefined && userId !== 0 ? eq(auditLogs.userId, userId) : undefined,
      ].filter((clause): clause is NonNullable<typeof clause> => clause !== undefined);

      const rows = await db.db.select().from(auditLogs)
        .where(filters.length > 0 ? and(...filters) : undefined)
        .orderBy(desc(auditLogs.id))
        .offset(skip)
        .limit(limit);

      return rows.map(toAuditLogOut);
    });
  });

  /* ---------------- 待审列表 ---------------- */

  app.get<{ Querystring: z.infer<typeof pendingQuerySchema> }>('/admin/pending', {
    schema: asRouteSchema({
      querystring: pendingQuerySchema,
      response: { 200: z.array(pendingFileOutSchema) },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const { skip, limit } = request.query;

    return app.withDb(async (db) => {
      const rows = await db.db.select().from(pendingFiles)
        .where(eq(pendingFiles.status, 'pending'))
        .orderBy(desc(pendingFiles.id))
        .offset(skip)
        .limit(limit);

      return rows.map(toPendingFileOut);
    });
  });

  /* ---------------- 审核通过 ---------------- */

  app.post<{
    Params: z.infer<typeof pendingIdParamsSchema>;
    Body: z.infer<typeof exportReviewRequestSchema>;
  }>('/admin/pending/:pending_id/approve', {
    schema: asRouteSchema({
      params: pendingIdParamsSchema,
      body: exportReviewRequestSchema,
      response: { 200: pendingFileOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { pending_id: pendingId } = request.params;
    const reason = request.body.reason ?? null;
    const { exportPublishValidDays } = getSettings();

    return app.withDb(async (db) => {
      // FOR UPDATE 行锁：并发审批同一条申请时，后到者阻塞直到前者提交，
      // 再靠下面的条件更新判定 409（对应 Python 的 with_for_update()）
      const [pending] = await db.db.select().from(pendingFiles)
        .where(eq(pendingFiles.id, pendingId))
        .for('update')
        .limit(1);

      if (pending === undefined) throw new HttpError(404, '申请不存在');
      if (pending.status !== 'pending') throw new HttpError(400, '该申请已处理');

      try {
        await stat(pending.filePath);
      } catch {
        throw new HttpError(400, '源文件已丢失，无法发布');
      }

      // B9：发布前复核内容哈希，防止「申请后修改文件」绕过内容审查。
      // 无 content_sha 的存量记录跳过（Python 同样行为）。
      if (pending.contentSha) {
        let sha: string;
        try {
          sha = await fileSha256(pending.filePath);
        } catch (error) {
          throw new HttpError(400, `校验文件失败: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (sha !== pending.contentSha) {
          await recordAudit(db, {
            userId: admin.id,
            action: 'export_approved',
            detail: `审核通过失败（内容已变更）: ${pending.fileName}`,
            ipAddr: clientIp,
            status: 'failed',
          });
          // 审计必须落库后再抛异常（异常会触发回滚）
          await db.commit();
          throw new HttpError(409, '文件内容自申请后已被修改，请拒绝该申请并要求重新提交');
        }
      }

      // 条件更新：把「是否仍为 pending」交给数据库判定，避免锁失效窗口内的重复发布
      const [claimed] = await db.db.update(pendingFiles)
        .set({ status: 'approved' })
        .where(and(eq(pendingFiles.id, pendingId), eq(pendingFiles.status, 'pending')))
        .returning();

      if (claimed === undefined) {
        throw new HttpError(409, '该申请已被其他管理员处理，请刷新列表');
      }

      const fileName = basename(claimed.filePath) || claimed.fileName;
      const targetDir = await publishedDir(claimed.id);
      const targetPath = join(targetDir, fileName);
      await copyFile(claimed.filePath, targetPath);

      const stats = await stat(targetPath);
      // Python 硬编码 30 天；这里改用同义配置 exportPublishValidDays（默认同为 30），
      // 让有效期与 results 发布链路共用同一个开关
      const expiresAt = new Date(Date.now() + exportPublishValidDays * 24 * 60 * 60 * 1000);

      await db.db.insert(exportResults).values({
        userId: claimed.userId,
        pendingFileId: claimed.id,
        resultName: fileName,
        filePath: targetPath,
        fileSize: stats.size,
        expiresAt,
      });

      const [updated] = await db.db.update(pendingFiles)
        .set({ reviewReason: reason, reviewedBy: admin.id })
        .where(eq(pendingFiles.id, pendingId))
        .returning();

      await recordAudit(db, {
        userId: admin.id,
        action: 'export_approved',
        detail: `审核通过: ${fileName}${reason ? ` 理由: ${reason}` : ''}`,
        ipAddr: clientIp,
      });
      await db.commit();

      return toPendingFileOut(updated ?? claimed);
    });
  });

  /* ---------------- 审核拒绝 ---------------- */

  app.post<{
    Params: z.infer<typeof pendingIdParamsSchema>;
    Body: z.infer<typeof exportReviewRequestSchema>;
  }>('/admin/pending/:pending_id/reject', {
    schema: asRouteSchema({
      params: pendingIdParamsSchema,
      body: exportReviewRequestSchema,
      response: { 200: pendingFileOutSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { pending_id: pendingId } = request.params;
    const reason = request.body.reason ?? null;

    return app.withDb(async (db) => {
      const [pending] = await db.db.select().from(pendingFiles)
        .where(eq(pendingFiles.id, pendingId))
        .limit(1);

      if (pending === undefined) throw new HttpError(404, '申请不存在');
      if (pending.status !== 'pending') throw new HttpError(400, '该申请已处理');

      const [updated] = await db.db.update(pendingFiles)
        .set({ status: 'rejected', reviewReason: reason, reviewedBy: admin.id })
        .where(eq(pendingFiles.id, pendingId))
        .returning();

      await recordAudit(db, {
        userId: admin.id,
        action: 'export_rejected',
        detail: `审核拒绝: ${pending.fileName}${reason ? ` 原因: ${reason}` : ''}`,
        ipAddr: clientIp,
      });
      await db.commit();

      return toPendingFileOut(updated ?? { ...pending, status: 'rejected', reviewReason: reason });
    });
  });

  /* ---------------- 用户列表（普通管理员） ---------------- */

  app.get<{ Querystring: z.infer<typeof paginationSchema> }>('/admin/users', {
    schema: asRouteSchema({
      querystring: paginationSchema,
      response: { 200: z.array(userOutSchema) },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const { skip, limit } = request.query;

    return app.withDb(async (db) => {
      const rows = await db.db.select().from(users)
        .orderBy(asc(users.id))
        .offset(skip)
        .limit(limit);

      return rows.map(toUserOut);
    });
  });

  /* ---------------- 平台连接配置 ---------------- */

  app.get('/admin/platform-config', {
    schema: asRouteSchema({ response: { 200: platformConfigResponseSchema } }),
    preHandler: [authenticate, requireAdmin],
  }, async () => app.withDb(readPlatformConfig));

  app.put<{ Body: z.infer<typeof platformConfigRequestSchema> }>('/admin/platform-config', {
    schema: asRouteSchema({
      body: platformConfigRequestSchema,
      // 前端按 { success, message } 判定保存结果（frontend/src/api/admin.ts），
      // 只回 message 会让 success 变成 undefined → 界面误报失败
      response: { 200: successResponseSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { host, port, username, workspace_dir: workspaceDir, output_path: outputPath } = request.body;

    return app.withDb(async (db) => {
      // 注意：此处刻意不传 db（与 Python 一致），白名单不含库中已存的 host。
      // 空 host 跳过校验（与 Python 的 `if req.host and not ...` 一致）：
      // 空值在 readPlatformConfig 里是 falsy，会回落到环境变量，等价于「恢复默认」
      if (host && !(await isAllowedTestHost(null, host))) {
        await recordAudit(db, {
          userId: admin.id,
          action: 'platform_config_save',
          detail: `平台配置保存被拒绝（主机不允许）: ${host}`,
          ipAddr: clientIp,
          status: 'failed',
        });
        await db.commit();
        throw new HttpError(400, '不允许的主机地址：仅允许已配置的 SFTP/RDS 主机、localhost 或内网地址');
      }

      // platform_config 是 key/value 表，统一以字符串存储（port 亦如此，与 Python 一致）
      await savePlatformConfig(db, {
        host,
        port: String(port),
        username,
        workspace_dir: workspaceDir,
        output_path: outputPath,
      }, admin.id);

      await recordAudit(db, {
        userId: admin.id,
        action: 'platform_config_save',
        detail: `保存平台连接配置: host=${host}:${port}, `
          + `workspace_dir=${workspaceDir}, output_path=${outputPath}`,
        ipAddr: clientIp,
      });
      await db.commit();

      return { success: true, message: '配置已保存并生效' };
    });
  });

  app.post<{ Body: z.infer<typeof platformTestRequestSchema> }>('/admin/platform/test', {
    schema: asRouteSchema({
      body: platformTestRequestSchema,
      response: { 200: successResponseSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { host, port, username, password } = request.body;

    return app.withDb(async (db) => {
      if (!(await isAllowedTestHost(db, host))) {
        await recordAudit(db, {
          userId: admin.id,
          action: 'platform_test',
          detail: `连接测试被拒绝（非法主机）: ${host}`,
          ipAddr: clientIp,
          status: 'failed',
        });
        await db.commit();
        throw new HttpError(400, '不允许的主机地址：仅允许已配置的 SFTP/RDS 主机、localhost 或内网地址');
      }

      const outcome = await probeSshConnection({ host, port, username, password });

      await recordAudit(db, {
        userId: admin.id,
        action: 'platform_test',
        detail: outcome.ok
          ? `测试连接数据分析PC成功: ${host}:${port} (${outcome.latencyMs}ms)`
          : `测试连接数据分析PC失败: ${host}:${port} (${outcome.message})`,
        ipAddr: clientIp,
        status: outcome.ok ? 'success' : 'failed',
      });
      await db.commit();

      // latency_ms：前端 PlatformTestResult 声明为可选，Python 也返回，保持一致
      return outcome.ok
        ? { success: true, message: `连接成功（${outcome.latencyMs}ms）`, latency_ms: outcome.latencyMs }
        : { success: false, message: outcome.message };
    });
  });

  /* ================= 超级管理员：用户管理 ================= */

  app.get('/admin/manage/users', {
    schema: asRouteSchema({ response: { 200: z.array(userAdminOutSchema) } }),
    preHandler: [authenticate, requireSuperadmin],
  }, async () => app.withDb(async (db) => {
    const rows = await db.db.select().from(users).orderBy(asc(users.id));
    return rows.map(toUserAdminOut);
  }));

  app.put<{
    Params: z.infer<typeof userIdParamsSchema>;
    Body: z.infer<typeof roleUpdateSchema>;
  }>('/admin/manage/users/:user_id/role', {
    schema: asRouteSchema({
      params: userIdParamsSchema,
      body: roleUpdateSchema,
      response: { 200: userAdminOutSchema },
    }),
    preHandler: [authenticate, requireSuperadmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { user_id: targetId } = request.params;
    const newRole = request.body.role.trim() as UserRole;

    if (!MANAGEABLE_ROLES.includes(newRole)) {
      throw new HttpError(400, `角色必须是 ${MANAGEABLE_ROLES.join(' 或 ')}`);
    }
    if (targetId === admin.id) {
      throw new HttpError(400, '不能修改自己的角色');
    }

    return app.withDb(async (db) => {
      const [target] = await db.db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (target === undefined) throw new HttpError(404, '用户不存在');

      assertNotSuperadmin(target);

      if (target.role === newRole) {
        return toUserAdminOut(target);
      }

      const oldRole = target.role;
      // 角色变化后旧 JWT 立即失效（与改密同一机制）
      const [updated] = await db.db.update(users)
        .set({ role: newRole, passwordVersion: (target.passwordVersion ?? 1) + 1 })
        .where(eq(users.id, targetId))
        .returning();

      await recordAudit(db, {
        userId: admin.id,
        action: 'update_user_role',
        detail: `[${admin.username}] 将 ${target.username} 的角色由 ${ROLE_LABEL[oldRole]} 改为 ${ROLE_LABEL[newRole]}`,
        ipAddr: clientIp,
      });
      await db.commit();

      return toUserAdminOut(updated ?? { ...target, role: newRole });
    });
  });

  app.post<{
    Params: z.infer<typeof userIdParamsSchema>;
    Body: z.infer<typeof resetPasswordSchema>;
  }>('/admin/manage/users/:user_id/reset-password', {
    schema: asRouteSchema({
      params: userIdParamsSchema,
      body: resetPasswordSchema,
      response: { 200: messageResponseSchema },
    }),
    preHandler: [authenticate, requireSuperadmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { user_id: targetId } = request.params;
    const newPassword = request.body.new_password;

    return app.withDb(async (db) => {
      const [target] = await db.db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (target === undefined) throw new HttpError(404, '用户不存在');

      assertNotSuperadmin(target);

      if (isDemoAccount(target.username)) {
        throw new HttpError(400, '演示账号不允许重置密码');
      }

      try {
        validatePasswordStrength(newPassword);
      } catch (error) {
        throw new HttpError(422, error instanceof Error ? error.message : String(error));
      }

      // 与注册链路一致：先 Windows 本地账号，再 Guacamole；任一步失败即中止，
      // 保证三端凭据不会分叉（失败时事务回滚，库中密码保持原值）
      try {
        await syncWindowsUser(target.username, newPassword);
        await upsertGuacUser(target.username, newPassword);
      } catch (error) {
        if (error instanceof WindowsAccountError) {
          throw new HttpError(502, `同步 Windows 账号失败: ${error.message}`);
        }
        throw new HttpError(502, `同步 Guacamole 失败: ${error instanceof Error ? error.message : String(error)}`);
      }

      const passwordHash = await hashPassword(newPassword);
      await db.db.update(users)
        .set({ passwordHash, passwordVersion: (target.passwordVersion ?? 1) + 1 })
        .where(eq(users.id, targetId));

      await recordAudit(db, {
        userId: admin.id,
        action: 'reset_password',
        detail: `管理员 ${admin.username} 重置用户 ${target.username} 的密码`,
        ipAddr: clientIp,
      });
      await db.commit();

      return { message: '密码已重置，该用户的旧登录态已失效' };
    });
  });
};

export { adminRoutes };
