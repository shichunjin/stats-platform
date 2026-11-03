/**
 * Guacamole (guacamole-auth-jdbc) 用户与专属连接同步 —— app/guac.py
 *
 * 注意：Guacamole 用的是**另一个数据库**（guac_db_url），不在 Drizzle schema 里，
 * 因此这里直接用 pg 执行参数化裸 SQL，不走 ORM。
 *
 * 密码算法遵循 guacamole-auth-jdbc 标准（已用 guacadmin 账号实测对齐）：
 *   password_salt = 32 字节随机盐
 *   password_hash = SHA256( 明文密码(UTF-8) + salt 的【大写】HEX 字符串(UTF-8) )
 *
 * ⚠️ 必须是**大写** HEX：Guacamole Java 端按 String.format("%02X", b) 拼接，
 * 官方 MySQL 示例 HEX(@salt) 同样返回大写。写成小写会导致写入成功但登录恒为
 * Invalid login —— 这是本模块最容易踩的坑。
 */
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { getSettings } from '../config/env.js';

let cachedPool: Pool | null = null;
let cachedUrl = '';

/**
 * 连接池按 URL 缓存。
 *
 * ⚠️ 必须比对 URL：连接串是运行时可读的配置（`getSettings()`），一旦变化而沿用旧池，
 * 所有查询仍会打到旧库 —— 静默写错库比直接报错危险得多。
 * 生产里连接串不会变，这条分支只为「配置热替换 / 测试」服务。
 */
const getGuacPool = (): Pool => {
  const { guacDbUrl } = getSettings();
  if (!guacDbUrl) throw new Error('guac_db_url 未配置');

  if (cachedPool && cachedUrl === guacDbUrl) return cachedPool;

  if (cachedPool) void cachedPool.end().catch(() => undefined);
  cachedPool = new Pool({ connectionString: guacDbUrl, max: 5, connectionTimeoutMillis: 5_000 });
  cachedPool.on('error', (error: Error) => {
    console.error('[guac] idle client error', error);
  });
  cachedUrl = guacDbUrl;
  return cachedPool;
};

export const disposeGuacPool = async (): Promise<void> => {
  await cachedPool?.end();
  cachedPool = null;
  cachedUrl = '';
};

/** 是否启用了 Guacamole 同步 */
export const guacSyncEnabled = (): boolean => Boolean(getSettings().guacDbUrl);

/**
 * guacamole-auth-jdbc 标准密码哈希：SHA256(密码 + 大写HEX(盐))
 *
 * 导出是为了让测试能对这个「跨语言契约」做已知答案断言
 * （对应 Python 的 `app.guac._hash_password`）；业务代码不要直接调用。
 */
export const hashPassword = (password: string, salt: Buffer): Buffer =>
  createHash('sha256')
    .update(Buffer.from(password, 'utf8'))
    .update(Buffer.from(salt.toString('hex').toUpperCase(), 'utf8'))
    .digest();

const connectionName = (username: string): string =>
  `${getSettings().guacConnectionPrefix}${username}`;

/**
 * RDP 目标（云桌面改造引入）。
 *
 * 原实现只连 `settings.rdsHost`（共享 RDS 主机）。多 VM 后每台 VM 一个 IP，
 * 连接参数必须能按实例覆盖 —— 不传 target 即沿用现状，**行为零变化**。
 */
export interface RdpTarget {
  readonly hostname: string;
  readonly port?: number;
}

/** 构建专属 RDP 连接参数（参数名遵循 Guacamole RDP 协议标准） */
export const buildRdpParameters = (
  username: string,
  password: string | null,
  target?: RdpTarget | null,
): Readonly<Record<string, string>> => {
  const {
    rdsHost, rdsPort, guacRdpAutoLogin, guacRdpDomain, guacRdpSecurity,
    guacRdpIgnoreCert, guacRecordingRoot, guacClipboardEnabled,
  } = getSettings();

  const hostname = target?.hostname ?? rdsHost;
  const port = target?.port ?? rdsPort;

  const params: Record<string, string> = {
    hostname,
    port: String(port),
    // 客户端窗口大小随浏览器自适应
    'resize-method': 'display-update',
    // 安全修复 A3：通道管控。剪贴板按 guacClipboardEnabled 放行（默认允许，
    // 业务需要复制粘贴）；驱动器/打印重定向仍然强制关闭，不受配置影响。
    'disable-copy': String(!guacClipboardEnabled),   // 远程 → 浏览器 复制
    'disable-paste': String(!guacClipboardEnabled),  // 浏览器 → 远程 粘贴
    'disable-drive': 'true',  // 禁用 Guacamole 虚拟盘（浏览器传文件通道）
    'disable-print': 'true',  // 禁用远程打印（PDF 重定向下载）
    'enable-drive': 'false',
    'enable-printing': 'false',
  };

  // B13：默认关闭。jdbc extension 明文存储连接密码，库泄露即 Windows 凭据泄露。
  if (guacRdpAutoLogin) {
    params.username = username;
    if (password) {
      // 注意：guacamole-auth-jdbc 以明文存储连接密码（其已知设计特性），
      // 因此必须保证 guacamole 库不暴露到公网（本项目仅映射 127.0.0.1）。
      params.password = password;
    }
    if (guacRdpDomain) params.domain = guacRdpDomain;
  }

  if (guacRdpSecurity) params.security = guacRdpSecurity;
  if (guacRdpIgnoreCert) params['ignore-cert'] = 'true';

  // 会话录像（审计），按用户隔离
  if (guacRecordingRoot) {
    const root = guacRecordingRoot.replace(/\/$/, '');
    Object.assign(params, {
      'enable-recording': 'true',
      'create-recording-path': 'true',
      'recording-path': `${root}/${username}`,
      'include-recording-name': 'true',
      'recording-name': 'recording',
    });
  }

  return params;
};

interface GuacConnection {
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[][]; rowCount: number | null }>;
}

/** 返回用户实体 ID，不存在则创建 */
const ensureEntity = async (conn: GuacConnection, username: string): Promise<number> => {
  const existing = await conn.query(
    'SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = $2',
    [username, 'USER'],
  );
  if (existing.rows.length > 0) return Number(existing.rows[0]![0]);

  await conn.query(
    'INSERT INTO guacamole_entity (name, type) VALUES ($1, $2)',
    [username, 'USER'],
  );
  const created = await conn.query(
    'SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = $2',
    [username, 'USER'],
  );
  return Number(created.rows[0]![0]);
};

/** 写入/更新 guacamole 用户密码行 */
const setUserPassword = async (
  conn: GuacConnection,
  entityId: number,
  password: string,
): Promise<void> => {
  const salt = randomBytes(32);
  const pwdHash = hashPassword(password, salt);
  const now = new Date();

  // 布尔列必须写标准 SQL 的 FALSE：PostgreSQL 不接受 integer 字面量 0
  const updated = await conn.query(
    'UPDATE guacamole_user SET password_hash = $1, password_salt = $2, password_date = $3, '
    + 'disabled = FALSE, expired = FALSE WHERE entity_id = $4',
    [pwdHash, salt, now, entityId],
  );

  if ((updated.rowCount ?? 0) === 0) {
    await conn.query(
      'INSERT INTO guacamole_user (entity_id, password_hash, password_salt, password_date, disabled, expired) '
      + 'VALUES ($1, $2, $3, $4, FALSE, FALSE)',
      [entityId, pwdHash, salt, now],
    );
  }
};

/**
 * 参数指纹。
 *
 * 同步连接是「DELETE 全部参数 + 重新 INSERT」，几十条 DML；DMS 每次 ensure
 * 都做一遍会白白放大 guacamole_db 的写压力。存下指纹，只有参数真变了才重写。
 */
export const hashParameters = (
  params: Readonly<Record<string, string>>,
): string => createHash('sha256')
  .update(JSON.stringify(Object.entries(params).sort(([a], [b]) => a.localeCompare(b))))
  .digest('hex')
  .slice(0, 64);

/** 创建或更新用户专属 RDP 连接，返回 connection_id（参数每次全量重写） */
const ensureConnection = async (
  conn: GuacConnection,
  username: string,
  password: string | null,
  target?: RdpTarget | null,
): Promise<number> => {
  const name = connectionName(username);

  const existing = await conn.query(
    'SELECT connection_id FROM guacamole_connection WHERE connection_name = $1',
    [name],
  );

  let connectionId: number;
  if (existing.rows.length > 0) {
    connectionId = Number(existing.rows[0]![0]);
  } else {
    await conn.query(
      "INSERT INTO guacamole_connection (connection_name, protocol, failover_only) VALUES ($1, 'rdp', FALSE)",
      [name],
    );
    const created = await conn.query(
      'SELECT connection_id FROM guacamole_connection WHERE connection_name = $1',
      [name],
    );
    connectionId = Number(created.rows[0]![0]);
  }

  await conn.query(
    'DELETE FROM guacamole_connection_parameter WHERE connection_id = $1',
    [connectionId],
  );

  const params = buildRdpParameters(username, password, target);
  for (const [key, value] of Object.entries(params)) {
    await conn.query(
      'INSERT INTO guacamole_connection_parameter (connection_id, parameter_name, parameter_value) '
      + 'VALUES ($1, $2, $3)',
      [connectionId, key, String(value)],
    );
  }

  return connectionId;
};

/** 授予用户对连接的 READ 权限（幂等）。只授自己的连接，形成用户间隔离。 */
const grantRead = async (
  conn: GuacConnection,
  entityId: number,
  connectionId: number,
): Promise<void> => {
  const existing = await conn.query(
    "SELECT 1 FROM guacamole_connection_permission WHERE entity_id = $1 AND connection_id = $2 AND permission = 'READ'",
    [entityId, connectionId],
  );
  if (existing.rows.length === 0) {
    await conn.query(
      "INSERT INTO guacamole_connection_permission (entity_id, connection_id, permission) VALUES ($1, $2, 'READ')",
      [entityId, connectionId],
    );
  }
};

/**
 * 在一个事务内执行 fn；失败整体回滚。
 * 对应 Python 的 `with engine.begin() as conn`。
 */
const inTransaction = async <T>(fn: (conn: GuacConnection) => Promise<T>): Promise<T> => {
  const client = await getGuacPool().connect();
  const conn: GuacConnection = {
    query: async (sql, params = []) => {
      const result = await client.query(sql, params as unknown[]);
      // Guacamole 的表结构不在 Drizzle schema 里，行类型是 any；
      // 统一转成「按列顺序的值数组」（Python 侧用 cursor.fetchall() 拿元组，语义相同）
      const rows = result.rows as readonly Record<string, unknown>[];
      return { rows: rows.map((row) => Object.values(row)), rowCount: result.rowCount };
    },
  };
  try {
    await client.query('BEGIN');
    const result = await fn(conn);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

/** 创建/更新 Guacamole 用户并确保其拥有专属 RDP 连接（注册与改密场景） */
export const upsertGuacUser = async (username: string, password: string): Promise<boolean> => {
  if (!guacSyncEnabled()) return false;

  await inTransaction(async (conn) => {
    const entityId = await ensureEntity(conn, username);
    await setUserPassword(conn, entityId, password);
    const connectionId = await ensureConnection(conn, username, password);
    await grantRead(conn, entityId, connectionId);
  });

  return true;
};

/**
 * 为已存在的 Guacamole 用户补齐/改写专属连接（老用户补偿 / VM 重建后改指新 IP）。
 * 不掌握明文密码，因此只建连接与授权、不改密码（自动登录参数中不写 password）。
 *
 * @param target 传了就把连接指向该主机（用户专属 VM）；不传沿用共享 RDS 主机。
 */
export const ensureUserConnection = async (
  username: string,
  target?: RdpTarget | null,
): Promise<number | null> => {
  const detail = await ensureUserConnectionDetail(username, target);
  return detail?.connectionId ?? null;
};

export interface GuacConnectionIds {
  readonly connectionId: number;
  readonly entityId: number;
}

/**
 * 同上，但连 `guacamole_entity.entity_id` 一并返回 —— DMS 要把连接映射落进
 * `guac_connection_map`（跨库引用），只拿 connection_id 不够。
 */
export const ensureUserConnectionDetail = async (
  username: string,
  target?: RdpTarget | null,
): Promise<GuacConnectionIds | null> => {
  if (!guacSyncEnabled()) return null;

  return inTransaction(async (conn) => {
    const row = await conn.query(
      'SELECT entity_id FROM guacamole_entity WHERE name = $1 AND type = $2',
      [username, 'USER'],
    );
    if (row.rows.length === 0) return null;

    const entityId = Number(row.rows[0]![0]);
    const connectionId = await ensureConnection(conn, username, null, target);
    await grantRead(conn, entityId, connectionId);
    return { connectionId, entityId };
  });
};

/** 按用户名查询其专属 RDP 连接 ID，不存在返回 null */
export const getUserConnectionId = async (username: string): Promise<number | null> => {
  if (!guacSyncEnabled()) return null;

  const pool = getGuacPool();
  const result = await pool.query(
    'SELECT connection_id FROM guacamole_connection WHERE connection_name = $1',
    [connectionName(username)],
  );
  if (result.rows.length === 0) return null;
  return Number((result.rows[0] as { connection_id: number }).connection_id);
};

/**
 * 撤销某条连接的所有 READ 授权（回收桌面时调用）。
 *
 * 只删权限、**不删连接**：连接记录本身是 DMS 的映射锚点（`guac_connection_map`
 * 存了 connection_id），删了下次重建要重新对齐；保留连接但没权限，用户在网关里
 * 就看不到入口，效果等价而副作用更小。
 */
export const revokeConnectionRead = async (connectionId: number): Promise<boolean> => {
  if (!guacSyncEnabled()) return false;

  return inTransaction(async (conn) => {
    const result = await conn.query(
      "DELETE FROM guacamole_connection_permission WHERE connection_id = $1 AND permission = 'READ'",
      [connectionId],
    );
    return (result.rowCount ?? 0) > 0;
  });
};
