/**
 * 数据申请路由 —— app/routers/applies.py
 * 用户提交/查看申请，管理员查看队列/处理/驳回
 */
import { desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, authenticate, requireAdmin } from '../auth/guards.js';
import { recordAudit } from '../audit.js';
import {
  dataApplies, messages, users,
  type ApplyPriority, type DataApply, type User,
} from '../db/schema.js';
import { getClientIp } from '../security/rate-limit.js';
import {
  dataApplyCreateSchema, dataApplyRejectRequestSchema, dataApplyOutSchema, toDataApplyOut,
  type DataApplyCreate,
} from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

const applyIdSchema = z.object({ apply_id: z.coerce.number().int().positive() }).strict();

/**
 * 解析 ISO 时间字符串。
 *
 * ⚠️ 刻意复刻 Python 的行为：`datetime.fromisoformat(v).replace(tzinfo=None)`
 * —— **直接丢弃偏移量而不做时区换算**。这意味着 "2026-01-01T00:00:00+08:00"
 * 会被当成 2026-01-01 00:00:00 存库，而不是换算成 UTC 的 2025-12-31 16:00:00。
 * 原实现疑似 bug，但存量数据依赖该语义，迁移阶段保持 1:1，仅在此标注待修。
 */
const NAIVE_ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/;

const parseNaiveDateTime = (value: string | null | undefined): Date | null => {
  if (!value) return null;
  const match = NAIVE_ISO_PATTERN.exec(value.trim());
  if (!match) throw new HttpError(422, `时间格式无法解析: ${value}`);

  const [, y, mo, d, h, mi, s = '0', ms = '0'] = match;
  // 必须用 Date.UTC：new Date(y, mo, ...) 会按**服务器本地时区**解释这组墙上时间，
  // 于是 TZ=+08:00 的机器上 "2026-01-01T00:00:00" 会存成 2025-12-31T16:00Z，
  // 与 Python 的 naive 语义（原样保留 00:00:00）差 8 小时，且随部署环境漂移。
  return new Date(Date.UTC(
    Number(y), Number(mo) - 1, Number(d),
    Number(h), Number(mi), Number(s), Number(ms.slice(0, 3).padEnd(3, '0')),
  ));
};

const VALID_PRIORITIES = new Set<string>(['low', 'medium', 'high']);

/**
 * 入向 schema 刻意不枚举 priority（对齐 Python 的裸 str），非法值在这里回落 'medium'。
 * 收窄成 ApplyPriority 交给类型系统兜底，避免把任意字符串写进枚举列。
 */
const toPriority = (value: string): ApplyPriority =>
  (VALID_PRIORITIES.has(value) ? value as ApplyPriority : 'medium');

/** 状态机：pending → processing → generating → completed / failed；rejected 为终态 */
const APPLY_STATUSES = [
  'pending', 'processing', 'generating', 'completed', 'failed', 'rejected',
] as const;

/** _to_dict 的等价物：带申请者用户名（原实现通过 relationship 懒加载） */
const toApplyWithOwner = (
  row: DataApply,
  owner: { username: string; displayName: string | null } | null,
) => ({
  ...toDataApplyOut(row),
  username: owner?.username ?? null,
  display_name: owner?.displayName ?? null,
});

const applyOutWithOwnerSchema = dataApplyOutSchema.extend({
  username: z.string().nullable(),
  display_name: z.string().nullable(),
});

export const appliesRoutes: FastifyPluginAsync = async (app) => {
  /* ---------------- 用户端 ---------------- */

  app.post<{ Body: DataApplyCreate }>('/user/data-applies', {
    schema: asRouteSchema({
      body: dataApplyCreateSchema,
      response: { 200: applyOutWithOwnerSchema },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const { purpose, fields, filters, time_range: timeRange, priority } = request.body;

    return app.withDb(async (db) => {
      const [created] = await db.db.insert(dataApplies).values({
        userId: user.id,
        dataName: 'testData',
        purpose,
        fields,
        filters,
        timeStart: parseNaiveDateTime(timeRange?.[0] ?? undefined),
        timeEnd: parseNaiveDateTime(timeRange?.[1] ?? undefined),
        priority: toPriority(priority),
        status: 'pending',
      }).returning();

      await recordAudit(db, {
        userId: user.id,
        action: 'data_apply_create',
        detail: `提交数据申请，用途：${purpose.slice(0, 50)}`,
        ipAddr: getClientIp(request),
      });
      await db.commit();

      return toApplyWithOwner(created!, { username: user.username, displayName: user.displayName });
    });
  });

  app.get('/user/data-applies', {
    schema: asRouteSchema({
      querystring: paginationSchema,
      response: { 200: z.array(applyOutWithOwnerSchema) },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const { skip, limit } = request.query as z.infer<typeof paginationSchema>;

    return app.withDb(async (db) => {
      const rows = await db.db.select()
        .from(dataApplies)
        .where(eq(dataApplies.userId, user.id))
        .orderBy(desc(dataApplies.createdAt), desc(dataApplies.id))
        .offset(skip)
        .limit(limit);   // 性能修复 C2：分页

      return rows.map((row) => toApplyWithOwner(row, {
        username: user.username,
        displayName: user.displayName,
      }));
    });
  });

  /* ---------------- 管理员端 ---------------- */

  const adminListSchema = paginationSchema.extend({
    status: z.enum(APPLY_STATUSES).optional(),
  }).strict();

  app.get<{ Querystring: z.infer<typeof adminListSchema> }>('/admin/data-applies', {
    schema: asRouteSchema({
      querystring: adminListSchema,
      response: { 200: z.array(applyOutWithOwnerSchema) },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const { skip, limit, status } = request.query;

    return app.withDb(async (db) => {
      const rows = await db.db.select({ apply: dataApplies, owner: users })
        .from(dataApplies)
        .leftJoin(users, eq(dataApplies.userId, users.id))
        .where(status ? eq(dataApplies.status, status) : undefined)
        .orderBy(desc(dataApplies.createdAt), desc(dataApplies.id))
        .offset(skip)
        .limit(limit);

      return rows.map(({ apply, owner }) => toApplyWithOwner(apply, owner));
    });
  });

  app.get('/admin/data-applies/:apply_id', {
    schema: asRouteSchema({
      params: applyIdSchema,
      response: { 200: applyOutWithOwnerSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const { apply_id: applyId } = request.params as z.infer<typeof applyIdSchema>;

    return app.withDb(async (db) => {
      const [row] = await db.db.select({ apply: dataApplies, owner: users })
        .from(dataApplies)
        .leftJoin(users, eq(dataApplies.userId, users.id))
        .where(eq(dataApplies.id, applyId))
        .limit(1);

      if (!row) throw new HttpError(404, '申请不存在');
      return toApplyWithOwner(row.apply, row.owner);
    });
  });

  app.post('/admin/data-applies/:apply_id/process', {
    schema: asRouteSchema({
      params: applyIdSchema,
      response: { 200: applyOutWithOwnerSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const { apply_id: applyId } = request.params as z.infer<typeof applyIdSchema>;

    return app.withDb(async (db) => {
      const [current] = await db.db.select().from(dataApplies).where(eq(dataApplies.id, applyId)).limit(1);
      if (!current) throw new HttpError(404, '申请不存在');
      if (current.status !== 'pending') throw new HttpError(400, '仅待审核申请可进入处理中');

      const [updated] = await db.db.update(dataApplies)
        .set({ status: 'processing', processedBy: admin.id })
        .where(eq(dataApplies.id, applyId))
        .returning();

      await recordAudit(db, {
        userId: admin.id,
        action: 'data_apply_process',
        detail: `申请 #${applyId} 进入处理中`,
        ipAddr: getClientIp(request),
      });
      await db.commit();

      return toApplyWithOwner(updated!, null);
    });
  });

  app.post<{
    Params: z.infer<typeof applyIdSchema>;
    Body: z.infer<typeof dataApplyRejectRequestSchema>;
  }>('/admin/data-applies/:apply_id/reject', {
    schema: asRouteSchema({
      params: applyIdSchema,
      body: dataApplyRejectRequestSchema,
      response: { 200: applyOutWithOwnerSchema },
    }),
    preHandler: [authenticate, requireAdmin],
  }, async (request) => {
    const admin = request.user as User;
    const { apply_id: applyId } = request.params;
    const { reason } = request.body;

    return app.withDb(async (db) => {
      const [current] = await db.db.select().from(dataApplies).where(eq(dataApplies.id, applyId)).limit(1);
      if (!current) throw new HttpError(404, '申请不存在');
      if (current.status === 'completed') throw new HttpError(400, '已完成的申请不能驳回');

      const [updated] = await db.db.update(dataApplies)
        .set({
          status: 'rejected',
          rejectReason: reason,
          finishedAt: new Date(),
          processedBy: admin.id,
        })
        .where(eq(dataApplies.id, applyId))
        .returning();

      await db.db.insert(messages).values({
        userId: updated!.userId,
        title: '您的数据申请被驳回',
        content: `申请 #${applyId} 已被驳回，原因：${reason}`,
        msgType: 'warning',
        link: '/user/my-requests',
      });

      await recordAudit(db, {
        userId: admin.id,
        action: 'data_apply_reject',
        detail: `驳回申请 #${applyId}：${reason}`,
        ipAddr: getClientIp(request),
      });
      await db.commit();

      return toApplyWithOwner(updated!, null);
    });
  });
};
