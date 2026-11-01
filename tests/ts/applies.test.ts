/**
 * 数据申请路由 —— 补 tests/ 缺失的覆盖（Python 侧没有对应测试文件）
 *
 * 核心回归点：GET /user/data-applies 曾在生产全量 500。
 * 原因是 `dataApplyOutSchema.filters` 直接复用了入向的严格 `filterMapSchema`，
 * 而 Python 时代写进库的 filters 是裸 dict（布尔、任意长度数组、嵌套对象都可能有）；
 * Fastify 的序列化器遇到不匹配 schema 的值是**运行时抛 TypeError**，不是忽略字段。
 * 教训：出向 schema 不能比库里的存量数据更严。
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPool } from '../../src/db/client.js';
import type { User } from '../../src/db/schema.js';
import { buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildTestApp();
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await resetDatabase();
});

interface ApplyOut {
  readonly id: number;
  readonly status: string;
  readonly purpose: string;
  readonly filters: Record<string, unknown>;
  readonly fields: readonly string[];
  readonly time_range: readonly (string | null)[] | null;
  readonly priority: string;
  readonly username: string | null;
  readonly reject_reason: string | null;
}

/** 直接改库写入「Python 时代」的 filters：绕开入向校验，模拟存量脏数据 */
const writeLegacyFilters = async (applyId: number, filters: unknown): Promise<void> => {
  await getPool().query('UPDATE data_applies SET filters = $1::jsonb WHERE id = $2', [
    JSON.stringify(filters),
    applyId,
  ]);
};

const createApply = async (
  user: User,
  payload: Record<string, unknown> = { purpose: '做留存分析' },
): Promise<ApplyOut> => {
  const response = await request(app, {
    method: 'POST',
    url: '/user/data-applies',
    user,
    payload,
  });
  expect(response.statusCode).toBe(200);
  return response.json<ApplyOut>();
};

describe('用户端申请', () => {
  it('创建申请后回显 filters，并带上申请者用户名', async () => {
    const user = await seedUser({ username: 'u1', displayName: '用户一' });

    const created = await createApply(user, {
      purpose: '做留存分析',
      fields: ['年龄', '部门'],
      filters: { 年龄: [18, 60], 部门: '研发部' },
      priority: 'high',
    });

    expect(created.status).toBe('pending');
    expect(created.priority).toBe('high');
    expect(created.fields).toEqual(['年龄', '部门']);
    expect(created.filters).toEqual({ 年龄: [18, 60], 部门: '研发部' });
    expect(created.username).toBe('u1');
  });

  it('非法 priority 回落为 medium（复刻 Python 行为）', async () => {
    const user = await seedUser({ username: 'u2' });
    const created = await createApply(user, { purpose: 'x', priority: 'urgent' });
    expect(created.priority).toBe('medium');
  });

  /** 第二个 500 回归：出向 time_range 用 tuple 会让「填了时间范围的申请」必抛错 */
  it('填了时间范围的申请能正常回读', async () => {
    const user = await seedUser({ username: 'tr' });
    await createApply(user, {
      purpose: '带时间范围',
      time_range: ['2026-01-01T00:00:00', '2026-02-01T00:00:00'],
    });

    const response = await request(app, { method: 'GET', url: '/user/data-applies', user });
    expect(response.statusCode).toBe(200);

    const [row] = response.json<ApplyOut[]>();
    expect(row?.time_range).toHaveLength(2);
    expect(row?.time_range?.[0]).toContain('2026-01-01');
  });

  it('未认证返回 401', async () => {
    const response = await request(app, {
      method: 'GET',
      url: '/user/data-applies',
      user: null,
    });
    expect(response.statusCode).toBe(401);
  });

  it('列表只返回本人的申请', async () => {
    const me = await seedUser({ username: 'me' });
    const other = await seedUser({ username: 'other' });
    await createApply(me, { purpose: '我的申请' });
    await createApply(other, { purpose: '别人的申请' });

    const response = await request(app, { method: 'GET', url: '/user/data-applies', user: me });
    expect(response.statusCode).toBe(200);

    const rows = response.json<ApplyOut[]>();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.purpose).toBe('我的申请');
  });

  /** 生产事故回归：这条用例在修复前是 500 */
  it('存量 filters 含非规范值时不报 500，原样透传', async () => {
    const user = await seedUser({ username: 'legacy' });
    const created = await createApply(user, { purpose: '存量数据' });

    const legacyFilters = {
      性别: true, // 布尔：入向 schema 不接受
      部门: ['A组', 'B组'], // 任意长度数组
      分数: [1, 2, 3], // 非二元元组
      备注: { note: '嵌套对象' }, // 对象
      空值: null,
    };
    await writeLegacyFilters(created.id, legacyFilters);

    const response = await request(app, { method: 'GET', url: '/user/data-applies', user });
    expect(response.statusCode).toBe(200);
    expect(response.json<ApplyOut[]>()[0]?.filters).toEqual(legacyFilters);
  });
});

describe('管理员端申请', () => {
  it('管理员详情在存量脏 filters 下同样不报 500', async () => {
    const user = await seedUser({ username: 'u3' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const created = await createApply(user, { purpose: 'p' });
    await writeLegacyFilters(created.id, { 开关: false, 列表: [1, 2, 3, 4] });

    const response = await request(app, {
      method: 'GET',
      url: `/admin/data-applies/${created.id}`,
      user: admin,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ApplyOut>().filters).toEqual({ 开关: false, 列表: [1, 2, 3, 4] });
  });

  it('普通用户访问管理员端点返回 403', async () => {
    const user = await seedUser({ username: 'u4' });
    const response = await request(app, {
      method: 'GET',
      url: '/admin/data-applies',
      user,
    });
    expect(response.statusCode).toBe(403);
  });

  it('处理中：pending → processing', async () => {
    const user = await seedUser({ username: 'u5' });
    const admin = await seedUser({ username: 'admin2', role: 'admin' });
    const created = await createApply(user, { purpose: 'p' });

    const response = await request(app, {
      method: 'POST',
      url: `/admin/data-applies/${created.id}/process`,
      user: admin,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ApplyOut>().status).toBe('processing');

    // 重复处理应被状态机拦下
    const again = await request(app, {
      method: 'POST',
      url: `/admin/data-applies/${created.id}/process`,
      user: admin,
    });
    expect(again.statusCode).toBe(400);
  });

  it('驳回后写站内信，并置为终态', async () => {
    const user = await seedUser({ username: 'u6' });
    const admin = await seedUser({ username: 'admin3', role: 'admin' });
    const created = await createApply(user, { purpose: 'p' });

    const response = await request(app, {
      method: 'POST',
      url: `/admin/data-applies/${created.id}/reject`,
      user: admin,
      payload: { reason: '字段不在开放范围' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<ApplyOut>().status).toBe('rejected');
    expect(response.json<ApplyOut>().reject_reason).toBe('字段不在开放范围');

    const { rows } = await getPool()
      .query<{ n: number }>('SELECT COUNT(*)::int AS n FROM messages WHERE user_id = $1', [user.id]);
    expect(rows[0]?.n).toBe(1);
  });
});
