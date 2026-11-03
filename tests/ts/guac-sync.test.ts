/**
 * Guacamole 用户同步 / 专属 RDP 连接 / 改密接口测试 —— tests/test_guac_sync.py
 *
 * 关键差异：**模拟 Guacamole JDBC 库不能用 SQLite**。
 * Python 侧 `sqlite:///tmp/guac.db` 一把梭；TS 侧只支持 PostgreSQL（见 db/client.ts），
 * 因此这里起**第二个 PGlite 实例**承载 guacamole-auth-jdbc 的最小 schema
 * （见 ./guac-db.ts：不能和主库共用一个实例，否则请求事务未提交时 guac 连接会饿死）。
 * 副作用是这些用例天然就是真实 PG 方言下的行为（布尔列、SERIAL、BYTEA），
 * 比 Python 的 SQLite 更接近生产。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { getSettings, overrideSettings, settingsSchema } from '../../src/config/env.js';
import { users } from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { verifyPasswordHash } from '../../src/auth/password.js';
import {
  buildRdpParameters, disposeGuacPool, ensureUserConnection, getUserConnectionId,
  hashPassword, upsertGuacUser,
} from '../../src/integrations/guac.js';
import { buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';
import { startGuacDatabase, stopGuacDatabase } from './guac-db.js';

/**
 * 免密直连（Guacamole REST API）与本文件无关，且登录/改密都会 best-effort 调用它。
 * 不 mock 的话每次都会真的去调 GUACAMOLE_URL 推导出的地址并打一条 warn 日志。
 */
vi.mock('../../src/integrations/guac-token.js', () => ({
  guacApiBase: (): string => 'http://127.0.0.1/api',
  fetchAuthToken: async (): Promise<null> => null,
  cacheAuthToken: async (): Promise<void> => undefined,
  rememberLoginToken: async (): Promise<void> => undefined,
  getValidAuthToken: async (): Promise<null> => null,
}));

/* ---------------- guacamole-auth-jdbc schema 最小子集 ---------------- */

const GUAC_SCHEMA = `
CREATE TABLE IF NOT EXISTS guacamole_entity (
    entity_id SERIAL PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    type VARCHAR(16) NOT NULL,
    UNIQUE (name, type)
);
CREATE TABLE IF NOT EXISTS guacamole_user (
    entity_id INTEGER PRIMARY KEY,
    password_hash BYTEA NOT NULL,
    password_salt BYTEA NOT NULL,
    password_date TIMESTAMP NOT NULL,
    disabled BOOLEAN NOT NULL DEFAULT FALSE,
    expired BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS guacamole_connection (
    connection_id SERIAL PRIMARY KEY,
    connection_name VARCHAR(128) NOT NULL,
    protocol VARCHAR(32) NOT NULL,
    failover_only BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE IF NOT EXISTS guacamole_connection_parameter (
    connection_id INTEGER NOT NULL,
    parameter_name VARCHAR(128) NOT NULL,
    parameter_value VARCHAR(4096) NOT NULL,
    PRIMARY KEY (connection_id, parameter_name)
);
CREATE TABLE IF NOT EXISTS guacamole_connection_permission (
    entity_id INTEGER NOT NULL,
    connection_id INTEGER NOT NULL,
    permission VARCHAR(16) NOT NULL,
    PRIMARY KEY (entity_id, connection_id, permission)
);
`;

/** 按 guacamole-auth-jdbc 标准重算哈希（盐用大写 HEX 拼接），用于断言 */
const guacHash = (password: string, salt: Buffer): Buffer =>
  createHash('sha256')
    .update(Buffer.from(password, 'utf8'))
    .update(Buffer.from(salt.toString('hex').toUpperCase(), 'utf8'))
    .digest();

interface GuacUserRow {
  readonly password_hash: Buffer;
  readonly password_salt: Buffer;
  readonly disabled: boolean;
  readonly expired: boolean;
}

/**
 * 查询用独立连接：guac 库与主库是不同的 PGlite 实例，
 * 不能复用 `getPool()`（那指向主库）。
 */
let guacQueryPool: Pool;

const queryGuacUser = async (username: string): Promise<GuacUserRow | undefined> => {
  const { rows } = await guacQueryPool.query<GuacUserRow>(
    'SELECT u.password_hash, u.password_salt, u.disabled, u.expired '
    + 'FROM guacamole_entity e JOIN guacamole_user u ON u.entity_id = e.entity_id '
    + "WHERE e.name = $1 AND e.type = 'USER'",
    [username],
  );
  return rows[0];
};

interface GuacConnection {
  readonly cid: number;
  readonly params: Readonly<Record<string, string>>;
  readonly perms: readonly number[];
}

/** 返回 (connection_id, {参数名: 值}, 该用户有权限的连接 id 列表) */
const queryConnection = async (username: string): Promise<GuacConnection | null> => {
  const name = `${getSettings().guacConnectionPrefix}${username}`;
  const found = await guacQueryPool.query<{ connection_id: number }>(
    'SELECT connection_id FROM guacamole_connection WHERE connection_name = $1', [name],
  );
  const cid = found.rows[0]?.connection_id;
  if (cid === undefined) return null;

  const params = await guacQueryPool.query<{ parameter_name: string; parameter_value: string }>(
    'SELECT parameter_name, parameter_value FROM guacamole_connection_parameter WHERE connection_id = $1',
    [cid],
  );
  const perms = await guacQueryPool.query<{ connection_id: number }>(
    'SELECT c.connection_id FROM guacamole_entity e '
    + 'JOIN guacamole_connection_permission c ON c.entity_id = e.entity_id '
    + "WHERE e.name = $1 AND e.type = 'USER'",
    [username],
  );

  return {
    cid,
    params: Object.fromEntries(params.rows.map((row) => [row.parameter_name, row.parameter_value])),
    perms: perms.rows.map((row) => row.connection_id),
  };
};

/* ---------------- 夹具 ---------------- */

let app: FastifyInstance;
let guacUrl: string;
const ORIGINAL = { ...getSettings() };

const enableGuac = (): void => {
  overrideSettings({
    guacDbUrl: guacUrl,
    guacRdpAutoLogin: true,
    windowsAccountSync: false,
  });
};

beforeAll(async () => {
  guacUrl = await startGuacDatabase();
  guacQueryPool = new Pool({ connectionString: guacUrl, max: 4 });
});

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestApp();

  // 连接池按 URL 缓存，换 URL 前必须释放
  await disposeGuacPool();
  await guacQueryPool.query('DROP TABLE IF EXISTS guacamole_connection_permission, '
    + 'guacamole_connection_parameter, guacamole_connection, guacamole_user, guacamole_entity');
  await guacQueryPool.query(GUAC_SCHEMA);

  enableGuac();
});

afterAll(async () => {
  overrideSettings(ORIGINAL);
  await disposeGuacPool();
  await guacQueryPool?.end();
  await app?.close();
  await stopGuacDatabase();
});

/* ============================================================
 * 密码哈希契约与默认值
 * ============================================================ */

describe('Guacamole 密码哈希契约', () => {
  it('B13：guac_rdp_auto_login 生产默认值必须是 false', () => {
    // 对应 Python 的 `Settings.model_fields["guac_rdp_auto_login"].default is False`
    expect(settingsSchema.shape.guacRdpAutoLogin.safeParse(undefined).data).toBe(false);
  });

  it('已知答案向量：SHA256(密码 + 大写HEX(盐))', () => {
    const salt = Buffer.from(Array.from({ length: 32 }, (_unused, i) => i));

    // 向量手工计算，不引用被测实现以外的值
    expect(hashPassword('Guacpass123', salt).toString('hex'))
      .toBe('dabe21571a2276e8fc3235b53420d26965dfa54022f14cbfcff13456fee03fd4');

    // 小写 hex 是曾经导致线上登录全失败的错误算法，必须与之不同
    expect(hashPassword('Guacpass123', salt).toString('hex'))
      .not.toBe('12a6606089c5955ef6730a624b9977b133d8568c1c3fc42eedbad048bb2a7300');
  });
});

/* ============================================================
 * 注册同步：专属连接
 * ============================================================ */

describe('注册同步', () => {
  it('创建 guac 账号（同密码）+ 专属 RDP 连接', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'guacuser', password: 'Guacpass123', display_name: 'Guac用户' },
    });
    expect(response.statusCode).toBe(200);

    const row = await queryGuacUser('guacuser');
    expect(row, 'Guacamole 库中应创建同名用户').toBeDefined();
    expect(row!.password_hash.equals(guacHash('Guacpass123', row!.password_salt))).toBe(true);

    const result = await queryConnection('guacuser');
    expect(result, '应为用户创建专属 RDP 连接').not.toBeNull();
    const { rdsHost, rdsPort } = getSettings();
    expect(result!.params.hostname).toBe(rdsHost);
    expect(result!.params.port).toBe(String(rdsPort));
    // RDP 用户名锁定为本人，RDP 密码与平台一致（自动登录）
    expect(result!.params.username).toBe('guacuser');
    expect(result!.params.password).toBe('Guacpass123');
    // 用户只有自己这一条连接的权限
    expect(result!.perms).toEqual([result!.cid]);
  });

  it('两个用户的连接互相隔离', async () => {
    await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'alice', password: 'Aa123456' },
    });
    await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'bob', password: 'Bb123456' },
    });

    const a = await queryConnection('alice');
    const b = await queryConnection('bob');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.cid).not.toBe(b!.cid);
    expect(a!.perms).toEqual([a!.cid]);
    expect(b!.perms).toEqual([b!.cid]);
    expect(a!.params.username).toBe('alice');
    expect(a!.params.password).toBe('Aa123456');
    expect(b!.params.username).toBe('bob');
    expect(b!.params.password).toBe('Bb123456');
  });

  it('重复同步不产生重复连接', async () => {
    await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'repeat', password: 'Aa123456' },
    });

    // 再次直接调用同步（模拟改密）
    await upsertGuacUser('repeat', 'Newpass789');

    const { rows } = await guacQueryPool.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM guacamole_connection WHERE connection_name = $1',
      [`${getSettings().guacConnectionPrefix}repeat`],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it('B13：关闭自动登录时连接参数不含凭据', async () => {
    overrideSettings({ guacRdpAutoLogin: false });

    await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'manual', password: 'Mm123456' },
    });

    const result = await queryConnection('manual');
    expect(result!.params).not.toHaveProperty('username');
    expect(result!.params).not.toHaveProperty('password');
    expect(result!.params.hostname).toBe(getSettings().rdsHost);
  });

  it('A3：外带通道强制禁用，录像目录按用户隔离', async () => {
    overrideSettings({
      guacDriveRoot: '/guacd/drives',
      guacRecordingRoot: '/guacd/records',
      guacClipboardEnabled: false,
    });

    await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'iso', password: 'Ii123456' },
    });

    const { params } = (await queryConnection('iso'))!;
    expect(params).not.toHaveProperty('drive-path');
    expect(params['disable-drive']).toBe('true');
    expect(params['enable-drive']).toBe('false');
    expect(params['disable-copy']).toBe('true');
    expect(params['disable-paste']).toBe('true');
    expect(params['disable-print']).toBe('true');
    expect(params['recording-path']).toBe('/guacd/records/iso');
    expect(params['enable-recording']).toBe('true');
  });

  it('未配置 guac_db_url 时静默跳过', async () => {
    overrideSettings({ guacDbUrl: '' });
    await disposeGuacPool();

    const response = await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'plainuser', password: 'Pp123456' },
    });
    expect(response.statusCode).toBe(200);
  });

  it('guac 同步失败 → 注册 502，平台不创建用户', async () => {
    // 指向一个没有服务监听的端口：连接必然失败
    overrideSettings({ guacDbUrl: 'postgres://postgres@127.0.0.1:59999/postgres' });
    await disposeGuacPool();

    const response = await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'failuser', password: 'Ff123456' },
    });
    expect(response.statusCode).toBe(502);
    expect(response.json<{ detail: string }>().detail).toContain('Guacamole');

    const created = await withSession(async (db) => {
      const rows = await db.db.select({ id: users.id }).from(users).where(eq(users.username, 'failuser'));
      return rows.length;
    });
    expect(created).toBe(0);
  });
});

/* ============================================================
 * 修改密码
 * ============================================================ */

describe('修改密码', () => {
  const registerAndLogin = async (username = 'pwduser', password = 'Oldpass123') => {
    await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username, password },
    });
    const login = await request(app, {
      method: 'POST', url: '/auth/login',
      payload: { username, password },
    });
    expect(login.statusCode).toBe(200);
    return { authorization: `Bearer ${login.json<{ access_token: string }>().access_token}` };
  };

  it('改密同步两侧（平台哈希 + guac 哈希 + 连接参数）', async () => {
    const headers = await registerAndLogin();

    const response = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      headers,
      payload: { old_password: 'Oldpass123', new_password: 'Newpass456' },
    });
    expect(response.statusCode).toBe(200);

    const user = await withSession(async (db) => {
      const [row] = await db.db.select().from(users).where(eq(users.username, 'pwduser')).limit(1);
      return row;
    });
    expect(await verifyPasswordHash('Newpass456', user!.passwordHash)).toBe(true);
    expect(await verifyPasswordHash('Oldpass123', user!.passwordHash)).toBe(false);

    const row = await queryGuacUser('pwduser');
    expect(row!.password_hash.equals(guacHash('Newpass456', row!.password_salt))).toBe(true);

    const result = await queryConnection('pwduser');
    expect(result!.params.password).toBe('Newpass456');

    const oldLogin = await request(app, {
      method: 'POST', url: '/auth/login',
      payload: { username: 'pwduser', password: 'Oldpass123' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await request(app, {
      method: 'POST', url: '/auth/login',
      payload: { username: 'pwduser', password: 'Newpass456' },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it('原密码错误返回 400', async () => {
    const headers = await registerAndLogin();

    const response = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      headers,
      payload: { old_password: 'wrongpass', new_password: 'Newpass456' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ detail: string }>().detail).toContain('原密码');
  });

  it('guac 同步失败 → 502，平台密码保持不变', async () => {
    const headers = await registerAndLogin();

    overrideSettings({ guacDbUrl: 'postgres://postgres@127.0.0.1:59999/postgres' });
    await disposeGuacPool();

    const response = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      headers,
      payload: { old_password: 'Oldpass123', new_password: 'Newpass456' },
    });
    expect(response.statusCode).toBe(502);

    const user = await withSession(async (db) => {
      const [row] = await db.db.select().from(users).where(eq(users.username, 'pwduser')).limit(1);
      return row;
    });
    expect(await verifyPasswordHash('Oldpass123', user!.passwordHash)).toBe(true);
  });

  it('演示账号禁止在线改密', async () => {
    const admin = await seedUser({ username: 'admin', role: 'admin' });

    const response = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      user: admin,
      payload: { old_password: 'admin123', new_password: 'Newpass456' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ detail: string }>().detail).toContain('演示账号');
  });

  it('未认证返回 401', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      payload: { old_password: 'a', new_password: 'Newpass456' },
    });
    expect(response.statusCode).toBe(401);
  });
});

/* ============================================================
 * 老用户补偿 + /session/connect
 * ============================================================ */

describe('老用户补偿与会话连接', () => {
  it('guac 账号已存在但无连接：补偿创建且不改密码', async () => {
    const salt = Buffer.alloc(32, 0x11);
    const oldHash = guacHash('legacypwd', salt);

    await guacQueryPool.query("INSERT INTO guacamole_entity (name, type) VALUES ('legacy', 'USER')");
    const entity = await guacQueryPool.query<{ entity_id: number }>(
      "SELECT entity_id FROM guacamole_entity WHERE name = 'legacy'",
    );
    const entityId = entity.rows[0]!.entity_id;
    await guacQueryPool.query(
      'INSERT INTO guacamole_user (entity_id, password_hash, password_salt, password_date, disabled, expired) '
      + 'VALUES ($1, $2, $3, $4, FALSE, FALSE)',
      [entityId, oldHash, salt, new Date('2026-01-01T00:00:00Z')],
    );

    const cid = await ensureUserConnection('legacy');
    expect(cid).not.toBeNull();
    expect(await getUserConnectionId('legacy')).toBe(cid);

    const row = await queryGuacUser('legacy');
    expect(row!.password_hash.equals(oldHash)).toBe(true);
  });

  it('guac 中不存在的用户返回 null', async () => {
    expect(await ensureUserConnection('ghost')).toBeNull();
  });

  it('/session/connect 返回专属连接 URL', async () => {
    await request(app, {
      method: 'POST', url: '/auth/register',
      payload: { username: 'sess', password: 'Ss123456' },
    });
    const user = await withSession(async (db) => {
      const [row] = await db.db.select().from(users).where(eq(users.username, 'sess')).limit(1);
      return row;
    });

    const response = await request(app, { method: 'POST', url: '/session/connect', user: user! });
    expect(response.statusCode).toBe(200);

    const cid = await getUserConnectionId('sess');
    expect(response.json<{ guac_url: string }>().guac_url.endsWith(String(cid))).toBe(true);
  });

  it('A4：未启用同步时拒绝回退共享连接（503）', async () => {
    overrideSettings({ guacDbUrl: '' });
    await disposeGuacPool();

    const user = await seedUser({ username: 'user1' });
    const response = await request(app, { method: 'POST', url: '/session/connect', user });
    expect(response.statusCode).toBe(503);
    expect(response.json<{ detail: string }>().detail).toContain('GUAC_DB_URL');
  });

  it('guac 中不存在该用户且无法补偿 → 503', async () => {
    const user = await seedUser({ username: 'orphan', password: 'Passw0rd!23' });

    const response = await request(app, { method: 'POST', url: '/session/connect', user });
    expect(response.statusCode).toBe(503);
  });
});

/* ============================================================
 * A3：RDP 连接参数通道管控
 * ============================================================ */

describe('A3 通道管控', () => {
  it('即使误配置虚拟盘根目录也不得开启外带通道', () => {
    overrideSettings({ guacDriveRoot: '/data/drive', guacRecordingRoot: '' });

    const params = buildRdpParameters('alice', 'pw');
    expect(params['disable-drive']).toBe('true');
    expect(params['disable-print']).toBe('true');
    expect(params['enable-drive']).toBe('false');
    expect(params).not.toHaveProperty('drive-path');
  });

  it('剪贴板默认放行（业务需要复制粘贴）', () => {
    overrideSettings({ guacClipboardEnabled: true });

    const params = buildRdpParameters('alice', 'pw');
    expect(params['disable-copy']).toBe('false');
    expect(params['disable-paste']).toBe('false');
    // 剪贴板放行不影响驱动器/打印的强制关闭
    expect(params['disable-drive']).toBe('true');
    expect(params['disable-print']).toBe('true');
  });

  it('GUAC_CLIPBOARD_ENABLED=false 时恢复 A3 全禁', () => {
    overrideSettings({ guacClipboardEnabled: false });

    const params = buildRdpParameters('alice', 'pw');
    expect(params['disable-copy']).toBe('true');
    expect(params['disable-paste']).toBe('true');
  });
});
