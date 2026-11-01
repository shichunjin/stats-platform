/**
 * 端到端接口测试 —— tests/test_api.py
 *
 * 与 Python 的几处必要差异（不是遗漏，是契约变更）：
 *  1. `POST /results/request-export` 现在**必须**带 `file_names`。
 *     Python 的 test_api.py 还在发空 body —— 那份用例已经落后于
 *     app/routers/results.py 的 RequestExportRequest（min_length=1），
 *     迁移时按当前实现写，行为语义（登记/跳过/重提）保持不变。
 *  2. 生产攻击面用例（B11/B12）在 Python 里靠「settings.app_env 默认 prod」生效；
 *     TS 侧 vitest.config.ts 把 APP_ENV 置为 dev（否则 /docs 断言无从谈起），
 *     所以这里显式用 `appEnv='prod'` 另建一个 app 实例来测。
 *  3. Python 用 monkeypatch 换模块内函数；TS 用 `vi.mock` 在**依赖边界**打桩，
 *     并用 `vi.hoisted` 让状态先于 mock 工厂初始化（否则工厂执行时变量还在 TDZ）。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getSettings, overrideSettings, settingsSchema } from '../../src/config/env.js';
import { getPool } from '../../src/db/client.js';
import {
  auditLogs, exportResults, messages, pendingFiles, type User,
} from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { limiter } from '../../src/security/rate-limit.js';
import { buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

/* ---------------- 外部系统替身 ---------------- */

const { guacState } = vi.hoisted(() => ({
  guacState: { syncEnabled: false, connectionId: null as number | null },
}));

const { winState } = vi.hoisted(() => ({
  winState: { syncEnabled: false, provisioned: [] as string[], fail: false },
}));

vi.mock('../../src/integrations/guac.js', () => ({
  disposeGuacPool: async (): Promise<void> => undefined,
  guacSyncEnabled: (): boolean => guacState.syncEnabled,
  buildRdpParameters: (): Record<string, string> => ({}),
  upsertGuacUser: async (): Promise<boolean> => false,
  ensureUserConnection: async (): Promise<number | null> => guacState.connectionId,
  getUserConnectionId: async (): Promise<number | null> => guacState.connectionId,
}));

vi.mock('../../src/integrations/windows-account.js', () => ({
  WindowsAccountError: class WindowsAccountError extends Error {},
  validateWindowsUsername: (): void => undefined,
  buildAccountScript: (): string => '',
  buildWorkspaceScript: (): string => '',
  windowsSyncEnabled: (): boolean => winState.syncEnabled,
  syncWindowsUser: async (): Promise<boolean> => false,
  provisionUserWorkspace: async (username: string): Promise<boolean> => {
    if (winState.fail) throw new Error('ssh down');
    winState.provisioned.push(username);
    return true;
  },
}));

/** Python conftest 的 `_no_remote_pending_pull`：禁止真实 SFTP 回拉 */
vi.mock('../../src/integrations/transfer.js', () => ({
  TransferError: class TransferError extends Error {},
  decodeRemote: (data: Buffer): string => data.toString('utf8'),
  connectSsh: async (): Promise<never> => { throw new Error('tests must not open SSH'); },
  execCommand: async (): Promise<{ stdout: string; stderr: string; code: number }> =>
    ({ stdout: '', stderr: '', code: 0 }),
  withSftp: async (): Promise<never> => { throw new Error('tests must not open SFTP'); },
  ensureRemoteDir: async (): Promise<void> => undefined,
  runIcaclsLock: async (): Promise<void> => undefined,
  uploadFileToWindows: async (): Promise<string> => 'C:\\StatsData\\x',
  listRemoteFiles: async (): Promise<readonly { filename: string; size: number }[]> => [],
  downloadFileFromWindows: async (): Promise<void> => undefined,
}));

/* ---------------- 夹具 ---------------- */

let app: FastifyInstance;
let prodApp: FastifyInstance;

/** 重建某用户的 pending 目录（对应 conftest 的 pending_dir fixture） */
const resetPendingDir = (userId: number): string => {
  const dir = join(getSettings().fileserverRoot, 'pending', String(userId));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
};

const writeCsv = (dir: string, name: string, body: string): void => {
  // utf-8-sig：Python 侧用 encoding="utf-8-sig"，这里手加 BOM 保持等价
  // 用转义写法而非字面量 BOM：no-irregular-whitespace 禁止源码里出现 U+FEFF
  writeFileSync(join(dir, name), `\uFEFF${body}\n`, 'utf8');
};

const findPending = async (userId: number) => withSession(async (db) => {
  const rows = await db.db.select().from(pendingFiles).where(eq(pendingFiles.userId, userId));
  return rows;
});

const findExports = async (userId: number) => withSession(async (db) => {
  const rows = await db.db.select().from(exportResults).where(eq(exportResults.userId, userId));
  return rows;
});

const countAudit = async (action: string, status?: 'success' | 'failed') =>
  withSession(async (db) => {
    const rows = await db.db.select().from(auditLogs).where(eq(auditLogs.action, action));
    return status === undefined ? rows.length : rows.filter((row) => row.status === status).length;
  });

const seedAudit = async (userId: number, action: string, detail: string): Promise<void> => {
  await withSession(async (db) => {
    await db.db.insert(auditLogs).values({ userId, action, detail });
  });
};

const seedMessages = async (userId: number, count: number): Promise<void> => {
  await withSession(async (db) => {
    await db.db.insert(messages).values(
      Array.from({ length: count }, (_unused, index) => ({
        userId,
        title: `t${index + 1}`,
        content: `c${index + 1}`,
      })),
    );
  });
};

/** 用户提交一个导出申请，返回 pending 记录 id */
const submitPending = async (
  user: User,
  pendingDir: string,
  name = 'result.csv',
): Promise<number> => {
  writeCsv(pendingDir, name, 'mean,std\n1.0,2.0');
  await request(app, {
    method: 'POST',
    url: '/results/request-export',
    user,
    payload: { file_names: [name] },
  });
  const mine = await request(app, { method: 'GET', url: '/results/mine', user });
  return mine.json<{ pending: { id: number }[] }>().pending[0]!.id;
};

beforeAll(async () => {
  // B11/B12 用例需要真正的 prod 实例：swagger 注册与 CORS 白名单都在 buildApp 时固化
  overrideSettings({ appEnv: 'prod' });
  prodApp = await buildTestApp();
  overrideSettings({ appEnv: 'dev' });
});

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestApp();

  guacState.syncEnabled = false;
  guacState.connectionId = null;
  winState.syncEnabled = false;
  winState.provisioned = [];
  winState.fail = false;
  limiter.reset();
});

afterAll(async () => {
  await app?.close();
  await prodApp?.close();
});

/* ============================================================
 * 健康检查 & 根路径
 * ============================================================ */

describe('健康检查 & 根路径', () => {
  it('健康检查', async () => {
    const response = await request(app, { method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('根路径返回 Vue SPA 入口页', async () => {
    const response = await request(app, { method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<div id="app">');
  });
});

/* ============================================================
 * 生产环境攻击面收敛（B11/B12）
 * ============================================================ */

describe('生产环境攻击面收敛', () => {
  it('B11：/docs 不暴露（含 SPA 回退兜底 404）', async () => {
    expect((await request(prodApp, { method: 'GET', url: '/docs' })).statusCode).toBe(404);
  });

  it('B11：/redoc 不暴露', async () => {
    expect((await request(prodApp, { method: 'GET', url: '/redoc' })).statusCode).toBe(404);
  });

  it('B11：/openapi.json 不暴露', async () => {
    expect((await request(prodApp, { method: 'GET', url: '/openapi.json' })).statusCode).toBe(404);
  });

  it('B12：生产 CORS 预检不回 echo localhost 来源', async () => {
    const response = await request(prodApp, {
      method: 'GET',
      url: '/auth/login',
      headers: {
        Origin: 'http://localhost:5173',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(response.headers['access-control-allow-origin']).not.toBe('http://localhost:5173');
  });

  it('B12：正式域名预检正常放行', async () => {
    const response = await request(prodApp, {
      method: 'GET',
      url: '/auth/login',
      headers: {
        Origin: 'https://chunjindevelop68.xyz',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(response.headers['access-control-allow-origin']).toBe('https://chunjindevelop68.xyz');
  });

  it('B1：rate_limit_enabled 声明的默认值必须是 true', () => {
    // 对应 Python 的 `Settings.model_fields["rate_limit_enabled"].default is True`：
    // 断言的是 schema 声明值，不受环境变量 / .env 影响
    expect(settingsSchema.shape.rateLimitEnabled.safeParse(undefined).data).toBe(true);
  });
});

/* ============================================================
 * 认证路由 /auth
 * ============================================================ */

describe('POST /auth/login', () => {
  it('管理员登录成功', async () => {
    await seedUser({ username: 'admin', displayName: '管理员', role: 'admin' });

    const response = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'admin123' },
    });
    expect(response.statusCode).toBe(200);
    const data = response.json<{ token_type: string; access_token: string }>();
    expect(data.token_type).toBe('bearer');
    expect(data.access_token.length).toBeGreaterThan(20);
  });

  it('普通用户登录成功', async () => {
    await seedUser({ username: 'user1' });

    const response = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'user1', password: 'user123' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('密码错误返回 401', async () => {
    await seedUser({ username: 'user1' });

    const response = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'user1', password: 'wrong' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain('错误');
  });

  it('不存在的用户返回 401', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'nobody', password: 'any' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('缺少字段返回 422', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('B1：限流开启时，同一 IP 登录超过 5 次/60s 返回 429', async () => {
    await seedUser({ username: 'user1' });
    overrideSettings({ rateLimitEnabled: true });
    limiter.reset();

    try {
      for (let i = 0; i < 5; i += 1) {
        const response = await request(app, {
          method: 'POST',
          url: '/auth/login',
          payload: { username: 'user1', password: 'user123' },
        });
        expect(response.statusCode).toBe(200);
      }

      const blocked = await request(app, {
        method: 'POST',
        url: '/auth/login',
        payload: { username: 'user1', password: 'user123' },
      });
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json<{ detail: string }>().detail).toContain('频繁');
    } finally {
      overrideSettings({ rateLimitEnabled: false });
      limiter.reset();
    }
  });
});

describe('GET /auth/me', () => {
  it('获取当前用户信息', async () => {
    const user = await seedUser({ username: 'user1', displayName: '测试用户1' });

    const response = await request(app, { method: 'GET', url: '/auth/me', user });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      username: 'user1', role: 'user', display_name: '测试用户1',
    });
  });

  it('无 Token 返回 401', async () => {
    expect((await request(app, { method: 'GET', url: '/auth/me' })).statusCode).toBe(401);
  });

  it('无效 Token 返回 401', async () => {
    const response = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: 'Bearer invalid_token' },
    });
    expect(response.statusCode).toBe(401);
  });
});

/* ============================================================
 * 会话路由 /session
 * ============================================================ */

describe('POST /session/connect', () => {
  it('同步已启用 → 返回专属连接', async () => {
    const user = await seedUser({ username: 'user1' });
    guacState.syncEnabled = true;
    guacState.connectionId = 42;

    const response = await request(app, { method: 'POST', url: '/session/connect', user });
    expect(response.statusCode).toBe(200);

    const data = response.json<Record<string, unknown>>();
    // 软件维度已下线：响应体不应再含 software 键
    expect(data).not.toHaveProperty('software');
    expect(data.status).toBe('active');
    expect(String(data.guac_url)).toMatch(/42$/);
  });

  it('A4：未启用 JDBC 同步时拒绝共享连接（503）', async () => {
    const user = await seedUser({ username: 'user1' });

    const response = await request(app, { method: 'POST', url: '/session/connect', user });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ detail: string }>().detail).toContain('GUAC_DB_URL');
  });

  it('连接时幂等补建私有工作区（老账号补偿）', async () => {
    const user = await seedUser({ username: 'user1' });
    guacState.syncEnabled = true;
    guacState.connectionId = 42;
    winState.syncEnabled = true;

    const response = await request(app, { method: 'POST', url: '/session/connect', user });
    expect(response.statusCode).toBe(200);
    expect(winState.provisioned).toEqual([user.username]);
  });

  it('工作区开通失败只记日志，不阻断远程连接', async () => {
    const user = await seedUser({ username: 'user1' });
    guacState.syncEnabled = true;
    guacState.connectionId = 42;
    winState.syncEnabled = true;
    winState.fail = true;

    const response = await request(app, { method: 'POST', url: '/session/connect', user });
    expect(response.statusCode).toBe(200);
    expect(response.json<Record<string, unknown>>()).toHaveProperty('guac_url');
  });

  it('未认证返回 401', async () => {
    expect((await request(app, { method: 'POST', url: '/session/connect' })).statusCode).toBe(401);
  });

  it('连接创建审计日志', async () => {
    const user = await seedUser({ username: 'user1' });
    guacState.syncEnabled = true;
    guacState.connectionId = 42;

    await request(app, { method: 'POST', url: '/session/connect', user });
    expect(await countAudit('session_connect')).toBeGreaterThanOrEqual(1);
  });

  it('连接创建会话记录，且 sessions 表不再含 software 列', async () => {
    const user = await seedUser({ username: 'user1' });
    guacState.syncEnabled = true;
    guacState.connectionId = 42;

    const response = await request(app, { method: 'POST', url: '/session/connect', user });
    const sessionId = response.json<{ id: number }>().id;

    const { rows } = await getPool().query<{ id: number }>(
      'SELECT id FROM sessions WHERE id = $1', [sessionId],
    );
    expect(rows).toHaveLength(1);

    const columns = await getPool().query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'",
    );
    expect(columns.rows.map((row) => row.column_name)).not.toContain('software');
  });
});

/* ============================================================
 * 结果路由 /results
 * ============================================================ */

describe('GET /results/mine', () => {
  it('无结果时返回空列表', async () => {
    const user = await seedUser({ username: 'user1' });

    const response = await request(app, { method: 'GET', url: '/results/mine', user });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ pending: [], published: [] });
  });

  it('未认证返回 401', async () => {
    expect((await request(app, { method: 'GET', url: '/results/mine' })).statusCode).toBe(401);
  });

  it('只返回自己的结果', async () => {
    const user = await seedUser({ username: 'user1' });
    const other = await seedUser({ username: 'other' });
    await withSession(async (db) => {
      await db.db.insert(pendingFiles).values({
        userId: other.id,
        fileName: 'other_result.csv',
        filePath: '/tmp/other.csv',
        fileType: 'csv',
        status: 'pending',
      });
    });

    const response = await request(app, { method: 'GET', url: '/results/mine', user });
    expect(response.json<{ pending: unknown[] }>().pending).toEqual([]);
  });
});

describe('POST /results/request-export', () => {
  it('空 pending 目录（目标文件不存在）', async () => {
    const user = await seedUser({ username: 'user1' });
    resetPendingDir(user.id);

    const response = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['result.csv'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ registered: number }>().registered).toBe(0);
  });

  it('登记待审核文件，状态为 pending', async () => {
    const user = await seedUser({ username: 'user1' });
    const dir = resetPendingDir(user.id);
    writeCsv(dir, 'result.csv', 'mean\n1.0');

    const response = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['result.csv'] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ registered: number }>().registered).toBe(1);

    const records = await findPending(user.id);
    expect(records).toHaveLength(1);
    expect(records[0]!.fileName).toBe('result.csv');
    expect(records[0]!.status).toBe('pending');
  });

  it('申请导出创建审计日志', async () => {
    const user = await seedUser({ username: 'user1' });
    const dir = resetPendingDir(user.id);
    writeCsv(dir, 'audit.csv', 'mean\n1.0');

    await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['audit.csv'] },
    });
    expect(await countAudit('export_requested')).toBeGreaterThanOrEqual(1);
  });

  it('已登记的文件不重复申请', async () => {
    const user = await seedUser({ username: 'user1' });
    const dir = resetPendingDir(user.id);
    writeCsv(dir, 'dup.csv', 'mean\n1.0');

    await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['dup.csv'] },
    });
    const second = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['dup.csv'] },
    });
    expect(second.json<{ registered: number }>().registered).toBe(0);
  });

  it('未认证返回 401', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      payload: { file_names: ['x.csv'] },
    });
    expect(response.statusCode).toBe(401);
  });

  it('B9：同名文件内容变更后重新申请，必须生成新申请', async () => {
    const user = await seedUser({ username: 'user1' });
    const dir = resetPendingDir(user.id);

    writeCsv(dir, 'changed.csv', 'mean\n1.0');
    const first = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['changed.csv'] },
    });
    expect(first.json<{ registered: number }>().registered).toBe(1);

    writeCsv(dir, 'changed.csv', 'mean,std\n2.0,3.0');
    const second = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['changed.csv'] },
    });
    expect(second.json<{ registered: number }>().registered).toBe(1);
  });
});

/* ============================================================
 * 管理员审核导出申请
 * ============================================================ */

describe('管理员审核导出申请', () => {
  it('审核通过创建导出结果', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const pid = await submitPending(user, dir);

    const response = await request(app, {
      method: 'POST',
      url: `/admin/pending/${pid}/approve`,
      user: admin,
      payload: { reason: '通过' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('approved');

    const exports = await findExports(user.id);
    expect(exports).toHaveLength(1);
    const { accessSync } = await import('node:fs');
    expect(() => accessSync(exports[0]!.filePath)).not.toThrow();
  });

  it('审核拒绝，不创建导出结果', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const pid = await submitPending(user, dir);

    const response = await request(app, {
      method: 'POST',
      url: `/admin/pending/${pid}/reject`,
      user: admin,
      payload: { reason: '含敏感数据' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }>().status).toBe('rejected');

    expect(await findExports(user.id)).toHaveLength(0);
  });

  it('普通用户不能审批', async () => {
    const user = await seedUser({ username: 'user1' });
    await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const pid = await submitPending(user, dir);

    const response = await request(app, {
      method: 'POST',
      url: `/admin/pending/${pid}/approve`,
      user,
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });

  it('审批不存在的申请返回 404', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const response = await request(app, {
      method: 'POST',
      url: '/admin/pending/9999/approve',
      user: admin,
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it('待审核列表只含 pending 项', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const pid = await submitPending(user, dir);

    await request(app, {
      method: 'POST',
      url: `/admin/pending/${pid}/approve`,
      user: admin,
      payload: {},
    });

    const response = await request(app, { method: 'GET', url: '/admin/pending', user: admin });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ status: string }[]>().every((item) => item.status === 'pending')).toBe(true);
  });

  it('B9：申请后改写文件内容，审核通过必须被阻止（409）', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const pid = await submitPending(user, dir);

    writeCsv(dir, 'result.csv', 'mean,std,evil\n9.9,8.8,7.7');

    const response = await request(app, {
      method: 'POST',
      url: `/admin/pending/${pid}/approve`,
      user: admin,
      payload: {},
    });
    expect(response.statusCode).toBe(409);

    const records = await findPending(user.id);
    expect(records[0]!.status).toBe('pending');
  });
});

/* ============================================================
 * 分页 + 审批并发认领（C2/C3）
 * ============================================================ */

describe('列表分页与审批并发', () => {
  it('C2：/admin/users 支持 skip/limit', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    await seedUser({ username: 'user1' });

    const first = await request(app, {
      method: 'GET', url: '/admin/users?limit=1&skip=0', user: admin,
    });
    const second = await request(app, {
      method: 'GET', url: '/admin/users?limit=1&skip=1', user: admin,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(first.json<unknown[]>()).toHaveLength(1);
    expect(second.json<unknown[]>()).toHaveLength(1);
    expect(first.json<{ id: number }[]>()[0]!.id).not.toBe(second.json<{ id: number }[]>()[0]!.id);
  });

  it('C2：/admin/pending 支持 limit 截断', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    writeCsv(dir, 'page1.csv', 'mean\n1.0');
    writeCsv(dir, 'page2.csv', 'mean\n1.0');

    await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['page1.csv', 'page2.csv'] },
    });

    const response = await request(app, {
      method: 'GET', url: '/admin/pending?limit=1', user: admin,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown[]>()).toHaveLength(1);
  });

  it('C3：重复 approve 只产生一条 ExportResult', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const pid = await submitPending(user, dir, 'once.csv');

    const first = await request(app, {
      method: 'POST', url: `/admin/pending/${pid}/approve`, user: admin, payload: {},
    });
    const second = await request(app, {
      method: 'POST', url: `/admin/pending/${pid}/approve`, user: admin, payload: {},
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(400);
    expect(await findExports(user.id)).toHaveLength(1);
  });

  it('C2：/messages 支持 limit', async () => {
    const user = await seedUser({ username: 'user1' });
    await seedMessages(user.id, 2);

    const response = await request(app, { method: 'GET', url: '/messages?limit=1', user });
    expect(response.statusCode).toBe(200);
    expect(response.json<unknown[]>()).toHaveLength(1);
  });
});

/* ============================================================
 * 结果下载
 * ============================================================ */

describe('POST /results/:id/download', () => {
  const approvedResultId = async (user: User, admin: User, dir: string): Promise<number> => {
    const pid = await submitPending(user, dir, 'downloadable.csv');
    await request(app, {
      method: 'POST', url: `/admin/pending/${pid}/approve`, user: admin, payload: {},
    });
    const mine = await request(app, { method: 'GET', url: '/results/mine', user });
    return mine.json<{ published: { id: number }[] }>().published[0]!.id;
  };

  it('下载已发布结果', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const resultId = await approvedResultId(user, admin, dir);

    const response = await request(app, {
      method: 'POST', url: `/results/${resultId}/download`, user,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/octet-stream');
  });

  it('下载不存在的结果返回 404', async () => {
    const user = await seedUser({ username: 'user1' });

    const response = await request(app, {
      method: 'POST', url: '/results/9999/download', user,
    });
    expect(response.statusCode).toBe(404);
  });

  it('下载次数递增', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const resultId = await approvedResultId(user, admin, dir);

    await request(app, { method: 'POST', url: `/results/${resultId}/download`, user });
    await request(app, { method: 'POST', url: `/results/${resultId}/download`, user });

    const exports = await findExports(user.id);
    expect(exports[0]!.downloadCount).toBe(2);
  });

  it('下载创建审计日志', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    const resultId = await approvedResultId(user, admin, dir);

    await request(app, { method: 'POST', url: `/results/${resultId}/download`, user });
    expect(await countAudit('result_download')).toBeGreaterThanOrEqual(1);
  });
});

/* ============================================================
 * 管理员路由 /admin
 * ============================================================ */

describe('GET /admin/audit', () => {
  it('管理员可以访问审计日志', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const response = await request(app, { method: 'GET', url: '/admin/audit', user: admin });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });

  it('普通用户不能访问审计日志', async () => {
    const user = await seedUser({ username: 'user1' });

    const response = await request(app, { method: 'GET', url: '/admin/audit', user });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ detail: string }>().detail).toContain('管理员');
  });

  it('未认证返回 401', async () => {
    expect((await request(app, { method: 'GET', url: '/admin/audit' })).statusCode).toBe(401);
  });

  it('按 action 过滤审计日志', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    await seedAudit(admin.id, 'login', 'test');
    await seedAudit(admin.id, 'session_launch', 'test');

    const response = await request(app, {
      method: 'GET', url: '/admin/audit?action=login', user: admin,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ action: string }[]>().every((log) => log.action === 'login')).toBe(true);
  });

  it('审计日志分页', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    for (let i = 0; i < 10; i += 1) {
      await seedAudit(admin.id, 'test', `item-${i}`);
    }

    const response = await request(app, {
      method: 'GET', url: '/admin/audit?skip=5&limit=3', user: admin,
    });
    expect(response.json<unknown[]>()).toHaveLength(3);
  });
});

describe('GET /admin/pending', () => {
  it('管理员可以查看所有待审查文件', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const response = await request(app, { method: 'GET', url: '/admin/pending', user: admin });
    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json())).toBe(true);
  });

  it('普通用户不能查看所有待审查', async () => {
    const user = await seedUser({ username: 'user1' });

    const response = await request(app, { method: 'GET', url: '/admin/pending', user });
    expect(response.statusCode).toBe(403);
  });
});

describe('GET /admin/users', () => {
  it('管理员可查看所有用户', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    await seedUser({ username: 'user1' });

    const response = await request(app, { method: 'GET', url: '/admin/users', user: admin });
    expect(response.statusCode).toBe(200);
    const usernames = response.json<{ username: string }[]>().map((u) => u.username);
    expect(usernames).toContain('admin');
    expect(usernames).toContain('user1');
  });

  it('普通用户不能查看所有用户', async () => {
    const user = await seedUser({ username: 'user1' });

    const response = await request(app, { method: 'GET', url: '/admin/users', user });
    expect(response.statusCode).toBe(403);
  });

  it('未认证返回 401', async () => {
    expect((await request(app, { method: 'GET', url: '/admin/users' })).statusCode).toBe(401);
  });
});

/* ============================================================
 * 端到端完整流程
 * ============================================================ */

describe('端到端流程', () => {
  it('完整流程：连接 → 申请导出 → 审核通过 → 下载', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);
    guacState.syncEnabled = true;
    guacState.connectionId = 42;

    // 1. 验证身份
    const me = await request(app, { method: 'GET', url: '/auth/me', user });
    expect(me.statusCode).toBe(200);
    expect(me.json<{ username: string }>().username).toBe('user1');

    // 2. 连接 Windows 分析平台
    const connect = await request(app, { method: 'POST', url: '/session/connect', user });
    expect(connect.statusCode).toBe(200);
    expect(connect.json<Record<string, unknown>>()).toHaveProperty('guac_url');

    // 3. 用户保存结果到 pending 目录
    writeCsv(dir, 'final_results.csv', 'term,estimate,std_err,p_value\nx1,0.85,0.05,0.001\nx2,-0.3,0.1,0.005');

    // 4. 申请导出
    const submitted = await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['final_results.csv'] },
    });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json<{ registered: number }>().registered).toBe(1);

    // 5. 管理员审核通过
    const pid = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ pending: { id: number }[] }>().pending[0]!.id;
    const approved = await request(app, {
      method: 'POST',
      url: `/admin/pending/${pid}/approve`,
      user: admin,
      payload: { reason: '通过' },
    });
    expect(approved.statusCode).toBe(200);

    // 6. 查看已发布结果
    const mine = await request(app, { method: 'GET', url: '/results/mine', user });
    const { published } = mine.json<{ published: { id: number; result_name: string }[] }>();
    expect(published).toHaveLength(1);
    expect(published[0]!.result_name).toBe('final_results.csv');

    // 7. 下载
    const download = await request(app, {
      method: 'POST', url: `/results/${published[0]!.id}/download`, user,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/octet-stream');

    // 8. 审计日志覆盖整个流程
    const actions = await withSession(async (db) => {
      const rows = await db.db.select({ action: auditLogs.action }).from(auditLogs);
      return rows.map((row) => row.action);
    });
    expect(actions).toContain('session_connect');
    expect(actions).toContain('export_requested');
    expect(actions).toContain('export_approved');
    expect(actions).toContain('result_download');
  });

  it('被拒绝的流程：申请导出被管理员拒绝', async () => {
    const user = await seedUser({ username: 'user1' });
    const admin = await seedUser({ username: 'admin', role: 'admin' });
    const dir = resetPendingDir(user.id);

    writeCsv(dir, 'sensitive.csv', 'mean,note\n1.0,电话13812345678');
    await request(app, {
      method: 'POST',
      url: '/results/request-export',
      user,
      payload: { file_names: ['sensitive.csv'] },
    });
    const pid = (await request(app, { method: 'GET', url: '/results/mine', user }))
      .json<{ pending: { id: number }[] }>().pending[0]!.id;

    const rejected = await request(app, {
      method: 'POST',
      url: `/admin/pending/${pid}/reject`,
      user: admin,
      payload: { reason: '含敏感数据' },
    });
    expect(rejected.statusCode).toBe(200);

    const mine = await request(app, { method: 'GET', url: '/results/mine', user });
    expect(mine.json<{ published: unknown[] }>().published).toEqual([]);

    expect(await countAudit('export_rejected')).toBeGreaterThanOrEqual(1);
  });
});

/* ============================================================
 * 安全响应头（C4 CSP）
 * ============================================================ */

describe('安全响应头', () => {
  it('CSP 头存在且含关键指令', async () => {
    const response = await request(app, { method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);

    const csp = String(response.headers['content-security-policy'] ?? '');
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('其它安全响应头', async () => {
    const response = await request(app, { method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['referrer-policy']).toBe('same-origin');
  });
});

/* ============================================================
 * 平台连接配置落库（C4）
 * ============================================================ */

describe('平台连接配置', () => {
  it('库中无配置时回退环境变量默认值，且密码永不返回', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const response = await request(app, { method: 'GET', url: '/admin/platform-config', user: admin });
    expect(response.statusCode).toBe(200);

    const data = response.json<Record<string, unknown>>();
    const { sftpHost, windowsWorkspaceDir, windowsDataDir } = getSettings();
    expect(data.host).toBe(sftpHost);
    expect(data.workspace_dir).toBe(windowsWorkspaceDir);
    expect(data.output_path).toBe(windowsDataDir);
    expect(data).not.toHaveProperty('password');
  });

  it('保存落库后 GET 返回库中值，并写审计日志', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const saved = await request(app, {
      method: 'PUT',
      url: '/admin/platform-config',
      user: admin,
      payload: {
        host: '10.99.0.1',
        port: 2222,
        username: 'stats',
        workspace_dir: 'D:/ws',
        output_path: 'D:/out',
      },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ success: boolean }>().success).toBe(true);

    const data = (await request(app, { method: 'GET', url: '/admin/platform-config', user: admin }))
      .json<Record<string, string | number>>();
    expect(data.host).toBe('10.99.0.1');
    expect(data.port).toBe(2222);
    expect(data.username).toBe('stats');
    expect(data.workspace_dir).toBe('D:/ws');
    expect(data.output_path).toBe('D:/out');

    expect(await countAudit('platform_config_save')).toBe(1);
    const detail = await withSession(async (db) => {
      const [row] = await db.db.select({ detail: auditLogs.detail })
        .from(auditLogs).where(eq(auditLogs.action, 'platform_config_save')).limit(1);
      return row?.detail ?? '';
    });
    expect(detail).toContain('D:/ws');
  });

  it('B3：公网 IP 被拒绝，并写失败审计', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const response = await request(app, {
      method: 'PUT',
      url: '/admin/platform-config',
      user: admin,
      payload: {
        host: '8.8.8.8', port: 22, username: '', workspace_dir: '', output_path: '',
      },
    });
    expect(response.statusCode).toBe(400);
    expect(await countAudit('platform_config_save', 'failed')).toBe(1);
  });

  it('普通用户不能保存/读取平台配置', async () => {
    const user = await seedUser({ username: 'user1' });

    const put = await request(app, {
      method: 'PUT',
      url: '/admin/platform-config',
      user,
      payload: {
        host: '', port: 22, username: '', workspace_dir: '', output_path: '',
      },
    });
    expect(put.statusCode).toBe(403);

    const get = await request(app, { method: 'GET', url: '/admin/platform-config', user });
    expect(get.statusCode).toBe(403);
  });
});
