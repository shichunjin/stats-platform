/**
 * 测试环境装配 —— tests/conftest.py 的进程级部分（建库 + 配置覆盖）
 *
 * 为什么在这里起数据库而不是 vitest 的 globalSetup：
 *  1. globalSetup 在主进程执行，它往 `process.env` 里写的 DATABASE_URL 不保证
 *     传到 worker 进程（实测没传过去），而 src/config/env.ts 在 import 阶段就要用
 *  2. 业务代码通过 `getSettings()` 惰性读连接串，因此在 setup 里
 *     `overrideSettings({ databaseUrl })` 就能生效，不需要真的环境变量
 *
 * 数据库用 PGlite（编译成 WASM 的真实 PostgreSQL）+ pglite-socket 暴露 PG wire 协议，
 * 业务代码里的 `pg` Pool / drizzle 一行都不用改。
 * 相比 Python 侧的 SQLite 内存库，PGlite 里 FOR UPDATE、SAVEPOINT、部分唯一索引
 * 都是真生效的 —— 更接近生产行为。
 */
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { overrideSettings } from '../../src/config/env.js';
import { runMigrations } from '../../src/bootstrap/migrate.js';
import { getPool } from '../../src/db/client.js';

const HOST = '127.0.0.1';
/** 按 pid 派生端口：固定端口会被上一次跑挂残留的进程占住（EADDRINUSE） */
const PORT = 55_000 + (process.pid % 1_000);

interface ServerHandle {
  readonly server: PGLiteSocketServer;
  readonly url: string;
}

/** setupFiles 会对每个测试文件重新求值，用 globalThis 保证只起一次服务 */
const SERVER_KEY = Symbol.for('stats-platform.pglite-server');

const startServer = async (): Promise<ServerHandle> => {
  const existing = (globalThis as Record<symbol, ServerHandle | undefined>)[SERVER_KEY];
  if (existing !== undefined) return existing;

  const db = await PGlite.create();
  const server = new PGLiteSocketServer({
    db,
    port: PORT,
    host: HOST,
    // 必须 ≥ 各连接池上限之和：主库池 max=20 + Guacamole 池 max=5；
    // PGlite 单实例串行执行查询，多开连接只是排队，不会并发
    maxConnections: 40,
  });
  await server.start();

  const handle: ServerHandle = { server, url: `postgres://postgres@${HOST}:${PORT}/postgres` };
  (globalThis as Record<symbol, ServerHandle | undefined>)[SERVER_KEY] = handle;
  return handle;
};

const { url } = await startServer();

overrideSettings({ databaseUrl: url });

/* ---- 建表（幂等；drizzle 自带「已应用」记录表）---- */

await runMigrations();

/* ---- 清库工具 ---- */

/** 所有业务表，按外键依赖倒序 TRUNCATE（循环外键 desk_instances ↔ desktop_vms 必须同语句出现） */
const TABLES = [
  'guac_connection_map',
  'desktop_tasks',
  'desktop_ip_allocations',
  'desktop_vms',
  'desk_instances',
  'desktop_quotas',
  'desktop_templates',
  'messages',
  'guac_auth_tokens',
  'platform_config',
  'data_applies',
  'audit_logs',
  'export_results',
  'pending_files',
  'sessions',
  'users',
] as const;

/**
 * 清空所有表并重置自增序列。
 *
 * Python 侧用「外层事务 + 保存点 + 测试结束回滚」做隔离；TS 侧做不到：
 * 业务代码自己管事务（withSession 会 BEGIN/COMMIT），外层再套事务会冲突。
 * 改为每个用例前 TRUNCATE —— 隔离粒度略粗，但对本项目的用例集等价且可靠。
 */
export const resetDatabase = async (): Promise<void> => {
  await getPool().query(`TRUNCATE TABLE ${TABLES.join(', ')} RESTART IDENTITY CASCADE`);
};

export const testDatabaseUrl = url;
