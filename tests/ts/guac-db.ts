/**
 * 模拟 Guacamole 的 JDBC 认证库 —— tests/test_guac_sync.py 的 `guac_db` fixture
 *
 * Python 侧是 `sqlite:///{tmp_path}/guac.db`（一个独立文件）；TS 侧只支持
 * PostgreSQL，因此这里起**第二个 PGlite 实例**并独占一个端口。
 *
 * ⚠️ 为什么不能复用主库实例（一开始踩过的坑）：
 * PGlite 单实例无法同时服务两个 pg Pool —— 当主库连接处于打开的事务中时，
 * 另一个池的新连接会一直排队直到 `connectionTimeoutMillis` 超时。
 * 而 /auth/register 正是在「请求会话事务未提交」时去连 guac 库，必然死锁。
 * 独立实例也顺带等价于 Python 的「独立库文件」语义（两个库互不干扰）。
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const HOST = '127.0.0.1';
/** 与主库错开段位：主库用 55_000 + pid%1000 */
const PORT = 56_000 + (process.pid % 1_000);

interface GuacServerHandle {
  readonly db: PGlite;
  readonly server: PGLiteSocketServer;
  readonly url: string;
}

const SERVER_KEY = Symbol.for('stats-platform.pglite-guac-server');

export const startGuacDatabase = async (): Promise<string> => {
  const cache = globalThis as Record<symbol, GuacServerHandle | undefined>;
  const existing = cache[SERVER_KEY];
  if (existing !== undefined) return existing.url;

  const db = await PGlite.create();
  const server = new PGLiteSocketServer({ db, port: PORT, host: HOST, maxConnections: 10 });
  await server.start();

  const handle: GuacServerHandle = { db, server, url: `postgres://postgres@${HOST}:${PORT}/postgres` };
  cache[SERVER_KEY] = handle;
  return handle.url;
};

export const stopGuacDatabase = async (): Promise<void> => {
  const cache = globalThis as Record<symbol, GuacServerHandle | undefined>;
  const handle = cache[SERVER_KEY];
  if (handle === undefined) return;

  await handle.server.stop();
  await handle.db.close();
  cache[SERVER_KEY] = undefined;
};
