/**
 * 请求级会话 —— app/database.py 的 get_db() 生成器
 *
 * 为什么要显式 BEGIN：
 *   PostgreSQL 默认 autocommit，若不开事务，`SELECT ... FOR UPDATE` 会在语句结束
 *   瞬间释放行锁 —— 而 SQLAlchemy Session 是 autobegin 的，事务一直挂到 commit()。
 *   不显式 BEGIN 会静默丢掉 B9 的并发保护，这是本步最容易踩的隐性行为差异。
 */
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PoolClient } from 'pg';
import { getPool, type AppDatabase } from './client.js';
import * as schema from './schema.js';

export interface DbSession {
  readonly db: AppDatabase;
  /** 是否已结束（commit/rollback 之后为 true），供 withSession 判断是否需要补提交 */
  readonly closed: boolean;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /** 归还连接；若事务仍未结束则先回滚 */
  close(): Promise<void>;
  /** 保存点：对应 `with db.begin_nested():` */
  beginNested<T>(fn: () => Promise<T>): Promise<T>;
}

class PostgresSession implements DbSession {
  readonly db: AppDatabase;

  private readonly client: PoolClient;

  private savepointDepth = 0;

  private isClosed = false;

  constructor(client: PoolClient) {
    this.client = client;
    this.db = drizzle(client, { schema });
  }

  get closed(): boolean {
    return this.isClosed;
  }

  async commit(): Promise<void> {
    if (this.isClosed) return;
    await this.client.query('COMMIT');
    this.isClosed = true;
  }

  async rollback(): Promise<void> {
    if (this.isClosed) return;
    await this.client.query('ROLLBACK');
    this.isClosed = true;
  }

  async close(): Promise<void> {
    if (!this.isClosed) {
      await this.client.query('ROLLBACK').catch(() => undefined);
      this.isClosed = true;
    }
    this.client.release();
  }

  /**
   * SAVEPOINT。手写而非用 Drizzle 的 tx.transaction()：
   * Drizzle 的嵌套事务内部会再发 BEGIN，与我们手动开的顶层事务冲突。
   * 保存点名由深度生成，不接受外部输入，无注入面。
   */
  async beginNested<T>(fn: () => Promise<T>): Promise<T> {
    const name = `sp${(this.savepointDepth += 1)}`;
    await this.db.execute(sql.raw(`SAVEPOINT ${name}`));
    try {
      const result = await fn();
      await this.db.execute(sql.raw(`RELEASE SAVEPOINT ${name}`));
      return result;
    } catch (error) {
      // 连接已死时回滚保存点也会失败：保留原始错误，把它作为 cause 挂上
      await this.db.execute(sql.raw(`ROLLBACK TO SAVEPOINT ${name}`))
        .catch((rollbackError: unknown) => {
          (error as { cause?: unknown }).cause ??= rollbackError;
        });
      throw error;
    }
  }
}

export interface OpenSessionOptions {
  /** 检出后先 SELECT 1，等价 SQLAlchemy pool_pre_ping */
  readonly prePing?: boolean;
}

export const openSession = async (
  options: OpenSessionOptions = {},
): Promise<DbSession> => {
  const client = await getPool().connect();
  try {
    if (options.prePing ?? true) await client.query('SELECT 1');
    await client.query('BEGIN');
    return new PostgresSession(client);
  } catch (error) {
    client.release();
    throw error;
  }
};

/** 成功提交、异常回滚、无论如何归还连接 */
export const withSession = async <T>(
  fn: (session: DbSession) => Promise<T>,
  options: OpenSessionOptions = {},
): Promise<T> => {
  const session = await openSession(options);
  try {
    const result = await fn(session);
    if (!session.closed) await session.commit();
    return result;
  } catch (error) {
    await session.rollback().catch(() => undefined);
    throw error;
  } finally {
    await session.close();
  }
};
