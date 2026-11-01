/**
 * 数据库插件 —— 替代 FastAPI 的 Depends(get_db)
 *
 * 每个请求一个事务会话；请求结束自动 commit / rollback / release。
 */
import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { withSession, type DbSession } from '../db/session.js';

declare module 'fastify' {
  interface FastifyInstance {
    withDb: <T>(fn: (db: DbSession) => Promise<T>) => Promise<T>;
  }
}

export const dbPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorate('withDb', withSession);
});
