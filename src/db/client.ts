/**
 * 数据库连接与会话管理 —— app/database.py
 *
 * 与 Python 的关键差异（都是有意为之）：
 *  1. 单一方言 PostgreSQL，不再支持 SQLite（避免 NodePgDatabase / BetterSQLite3Database
 *     联合类型带来的类型噪音；同时消除 SQLite 下 FOR UPDATE 空操作的隐患）
 *  2. 连接/会话改为可变 registry，供测试整体替换（ESM 无法重赋值 export const）
 *  3. pool_pre_ping 手动实现（pg 无对应参数）
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import { ConfigError, getSettings } from '../config/env.js';
import * as schema from './schema.js';

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface PoolOptions {
  /** 对齐 SQLAlchemy pool_size=20 */
  readonly max: number;
  readonly idleTimeoutMillis: number;
  readonly connectionTimeoutMillis: number;
  /** 替代 pool_pre_ping 的主力旋钮：定期淘汰老连接 */
  readonly maxLifetimeSeconds: number;
  /** 每次检出连接时先 SELECT 1（等价 pool_pre_ping，代价是一次额外往返） */
  readonly prePing: boolean;
}

export const DEFAULT_POOL_OPTIONS: PoolOptions = {
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  maxLifetimeSeconds: 1_800,
  prePing: true,
};

interface DbState {
  pool: Pool | null;
  database: AppDatabase | null;
}

const state: DbState = { pool: null, database: null };

const assertPostgresUrl = (url: string): void => {
  if (/^sqlite/i.test(url)) {
    throw new ConfigError([{
      field: 'databaseUrl',
      envName: 'DATABASE_URL',
      message:
        'TS 侧不再支持 SQLite。测试请改用 PGlite（经 pglite-socket 暴露 wire 协议）或 Docker PostgreSQL',
    }]);
  }
};

export const createPool = (options: Partial<PoolOptions> = {}): Pool => {
  const { databaseUrl } = getSettings();
  assertPostgresUrl(databaseUrl);

  const merged: PoolOptions = { ...DEFAULT_POOL_OPTIONS, ...options };
  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: merged.max,
    idleTimeoutMillis: merged.idleTimeoutMillis,
    connectionTimeoutMillis: merged.connectionTimeoutMillis,
    maxLifetimeSeconds: merged.maxLifetimeSeconds,
  };

  const pool = new Pool(config);
  // 空闲连接上的后端错误必须捕获，否则冒泡成未处理 error 事件打挂进程
  pool.on('error', (error: Error) => {
    console.error('[db] idle client error', error);
  });

  return pool;
};

/** 懒初始化 + memo。首次调用即建池，失败即抛（fail-fast） */
export const getPool = (): Pool => {
  if (state.pool === null) {
    state.pool = createPool();
    state.database = drizzle(state.pool, { schema });
  }
  return state.pool;
};

/** 无事务的裸连接（只读查询 / 迁移用）。路由层请用 withSession() */
export const getDb = (): AppDatabase => {
  getPool();
  return state.database as AppDatabase;
};

/** 测试钩子：整体替换连接（对应 conftest.py:37-38 的 _db_module.engine = TEST_ENGINE） */
export const overrideDatabase = (patch: Partial<DbState>): void => {
  Object.assign(state, patch);
};

export const closeDatabase = async (): Promise<void> => {
  await state.pool?.end();
  state.pool = null;
  state.database = null;
};
