/**
 * 数据路由 —— app/routers/data.py
 * POST /data/fetch（已停用）, GET /data/columns, POST /data/generate
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, authenticate, requireAdmin } from '../auth/guards.js';
import { recordAudit } from '../audit.js';
import { getSettings } from '../config/env.js';
import { dataApplies, messages, users, type User } from '../db/schema.js';
import { withSession } from '../db/session.js';
import {
  analyzeTableColumns, generateFilteredExcelFromTable, timestampFilename,
} from '../services/dataset.js';
import { isInflight, submitGenerate } from '../services/jobs.js';
import { getWorkspaceRoot } from '../services/platform-config.js';
import { uploadFileToWindows } from '../integrations/transfer.js';
import { getClientIp } from '../security/rate-limit.js';
import {
  dataColumnOutSchema, filteredDataGenerateRequestSchema,
  type FilteredDataGenerateRequest,
} from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

/** B5：规范化文件名，防路径穿越（如 ../../etc/passwd） */
const sanitizeFilename = (raw: string): string => {
  let name = raw.replace(/[^\w\-.一-龥]/g, '_');
  name = name.replace(/^\.+/, '').replace(/\.{2,}/g, '.');
  return name;
};

export interface GenerateJobParams {
  readonly applyId: number;
  readonly adminId: number;
  readonly targetId: number;
  readonly filename: string;
  readonly outPath: string;
  readonly filters: Readonly<Record<string, unknown>>;
  readonly clientIp: string;
}

/**
 * 后台生成任务本体（Excel 生成 → 超时检查 → SFTP 推送 → 状态回写）。
 * 使用**独立会话**：请求会话随响应关闭，后台任务不得复用。
 */
export const runGenerateJob = async (params: GenerateJobParams): Promise<void> => {
  const { applyId, adminId, targetId, filename, outPath, filters, clientIp } = params;
  const { testdataTable, generateTimeoutSeconds } = getSettings();
  const started = Date.now();

  await withSession(async (db) => {
    try {
      await mkdir(join(outPath, '..'), { recursive: true });

      // 1. 按筛选生成 Excel
      const [rows, columns] = await generateFilteredExcelFromTable(
        db, testdataTable, outPath, filters,
      );

      // 软超时检查点（CPU 密集段无法中断，此为阶段间检查）
      const elapsed = (Date.now() - started) / 1_000;
      if (elapsed > generateTimeoutSeconds) {
        throw new Error(`生成耗时 ${Math.round(elapsed)}s 超过上限 ${generateTimeoutSeconds}s`);
      }

      const [target] = await db.db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (!target) throw new Error(`目标用户不存在: ${targetId}`);

      // 2. 推送到目标用户的 Windows 个人工作区（W: 盘），投递后锁定为本人私有
      const remoteDir = `${await getWorkspaceRoot(db)}/${target.username}`;
      const winPath = await uploadFileToWindows(outPath, {
        remoteDir,
        remoteName: filename,
        lockOwner: target.username,
      });

      // 3. 申请置完成 + 站内消息通知目标用户
      await db.db.update(dataApplies)
        .set({ status: 'completed', finishedAt: new Date() })
        .where(eq(dataApplies.id, applyId));

      await db.db.insert(messages).values({
        userId: target.id,
        title: '您申请的数据已生成',
        content: `数据文件 ${filename}（${rows} 行 × ${columns} 列）已生成，请连接数据分析PC，在 W: 盘打开使用。`,
        msgType: 'success',
        link: '/user/my-requests',
      });

      await recordAudit(db, {
        userId: adminId,
        action: 'data_generate',
        detail: `为用户 ${target.username}(id=${targetId}) 生成 ${filename}: ${rows} 行, ${columns} 列，推送至 ${winPath}（耗时 ${Math.round(elapsed)}s）`,
        ipAddr: clientIp,
      });

      await db.commit();
    } catch (error) {
      await db.rollback().catch(() => undefined);
      const reason = error instanceof Error ? error.message : String(error);

      await db.db.update(dataApplies)
        .set({ status: 'failed', rejectReason: `生成失败: ${reason.slice(0, 400)}`, finishedAt: new Date() })
        .where(eq(dataApplies.id, applyId));

      await recordAudit(db, {
        userId: adminId,
        action: 'data_generate',
        detail: `后台生成失败（申请 #${applyId}，文件 ${filename}）: ${reason.slice(0, 300)}`,
        status: 'failed',
        ipAddr: clientIp,
      });
      await db.commit();
    }
  });
};

export const dataRoutes: FastifyPluginAsync = async (app) => {
  // A1：原实现允许任意登录用户一键拉取全量宽表。保留路由以显式拒绝旧客户端。
  app.post('/data/fetch', { preHandler: [authenticate] }, async () => {
    throw new HttpError(403, '直接获取数据已停用，请通过「申请获取数据」由管理员生成');
  });

  app.get('/data/columns', {
    schema: asRouteSchema({ response: { 200: z.array(dataColumnOutSchema) } }),
    preHandler: [authenticate],
  }, async () => {
    const { testdataTable } = getSettings();

    return app.withDb(async (db) => {
      try {
        return await analyzeTableColumns(db, testdataTable);
      } catch (error) {
        if (error instanceof Error && error.message.includes('不存在')) {
          throw new HttpError(404, error.message);
        }
        throw new HttpError(500, `分析列结构失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  });

  app.post<{ Body: FilteredDataGenerateRequest }>('/data/generate', {
    schema: asRouteSchema({
      body: filteredDataGenerateRequestSchema,
      response: {
        200: z.object({
          status: z.string(),
          apply_id: z.number().int(),
          filename: z.string(),
          target_user: z.string(),
          detail: z.string(),
        }),
      },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const clientIp = getClientIp(request);
    const { target_user_id: targetUserId, filename: rawFilename, filters, apply_id: applyId } = request.body;
    const { datasetName, fileserverRoot } = getSettings();

    return app.withDb(async (db) => {
      const [target] = await db.db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!target) throw new HttpError(404, '目标用户不存在');

      let applyIdToUse: number;

      if (applyId !== null && applyId !== undefined) {
        // 行锁：并发下只有一个请求能认领该申请
        const [locked] = await db.db.select().from(dataApplies)
          .where(eq(dataApplies.id, applyId)).for('update').limit(1);

        if (!locked || locked.userId !== targetUserId) {
          throw new HttpError(400, '申请不存在、已处理或不属于目标用户');
        }
        if (!['pending', 'processing', 'failed', 'generating'].includes(locked.status)) {
          throw new HttpError(400, `申请当前状态为「${locked.status}」，不可生成`);
        }
        // 「生成中」且任务确在内存中执行时拒绝重复提交；
        // 进程重启残留的 stale「生成中」允许重新认领
        if (locked.status === 'generating' && isInflight(locked.id)) {
          throw new HttpError(409, '该申请正在生成中，请勿重复提交');
        }
        applyIdToUse = locked.id;
      } else {
        // 管理员直接分配 —— 自动建一条申请记录作为分配痕迹
        const [created] = await db.db.insert(dataApplies).values({
          userId: target.id,
          dataName: datasetName,
          purpose: '管理员直接分配',
          priority: 'medium',
          status: 'processing',
          processedBy: admin.id,
        }).returning();
        applyIdToUse = created!.id;
      }

      // B5：规范化文件名，防路径穿越
      let filename = sanitizeFilename(rawFilename ?? timestampFilename(datasetName));
      if (!filename) filename = timestampFilename(datasetName);
      if (!filename.toLowerCase().endsWith('.xlsx')) filename += '.xlsx';

      const outPath = join(fileserverRoot, 'generated', String(target.id), filename);

      // C1：认领申请（置 generating）后立即返回，生成 + 推送交由后台执行
      await db.db.update(dataApplies)
        .set({ status: 'generating', rejectReason: null, processedBy: admin.id })
        .where(eq(dataApplies.id, applyIdToUse));

      await recordAudit(db, {
        userId: admin.id,
        action: 'data_generate',
        detail: `受理生成申请 #${applyIdToUse}（目标 ${target.username}(id=${target.id})，文件 ${filename}，筛选 ${Object.keys(filters).length} 项），后台生成中`,
        ipAddr: clientIp,
      });
      await db.commit();

      const accepted = submitGenerate(applyIdToUse, async () => {
        await runGenerateJob({
          applyId: applyIdToUse,
          adminId: admin.id,
          targetId: target.id,
          filename,
          outPath,
          filters,
          clientIp,
        });
      });

      if (!accepted) throw new HttpError(409, '该申请正在生成中，请勿重复提交');

      return {
        status: 'generating',
        apply_id: applyIdToUse,
        filename,
        target_user: target.displayName ?? target.username,
        // B14：不返回服务器本地绝对路径
        detail: '已受理，后台生成中，完成后用户将收到站内消息',
      };
    });
  });
};
