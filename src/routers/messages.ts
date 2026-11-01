/**
 * 消息中心路由 —— app/routers/messages.py
 * GET /messages, POST /messages/:id/read, POST /messages/read-all
 */
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { HttpError, authenticate } from '../auth/guards.js';
import { messages, type User } from '../db/schema.js';
import { messageOutSchema, toMessageOut } from '../schemas/index.js';
import { asRouteSchema } from '../plugins/validator.js';

const paginationSchema = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
}).strict();

const messageIdSchema = z.object({ message_id: z.coerce.number().int().positive() }).strict();

export const messageRoutes: FastifyPluginAsync = async (app) => {
  app.get('/messages', {
    schema: asRouteSchema({
      querystring: paginationSchema,
      response: { 200: z.array(messageOutSchema) },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const { skip, limit } = request.query as z.infer<typeof paginationSchema>;

    return app.withDb(async (db) => {
      const rows = await db.db.select()
        .from(messages)
        .where(eq(messages.userId, user.id))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .offset(skip)
        .limit(limit);

      return rows.map(toMessageOut);
    });
  });

  app.post('/messages/:message_id/read', {
    schema: asRouteSchema({
      params: messageIdSchema,
      response: { 200: messageOutSchema },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;
    const { message_id: messageId } = request.params as z.infer<typeof messageIdSchema>;

    return app.withDb(async (db) => {
      const [row] = await db.db.select().from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.userId, user.id)))
        .limit(1);

      if (!row) throw new HttpError(404, '消息不存在');

      if (!row.isRead) {
        const [updated] = await db.db.update(messages)
          .set({ isRead: true })
          .where(eq(messages.id, messageId))
          .returning();
        await db.commit();
        return toMessageOut(updated!);
      }

      return toMessageOut(row);
    });
  });

  app.post('/messages/read-all', {
    schema: asRouteSchema({
      response: { 200: z.object({ count: z.number().int() }) },
    }),
    preHandler: [authenticate],
  }, async (request) => {
    const user = request.user as User;

    return app.withDb(async (db) => {
      const updated = await db.db.update(messages)
        .set({ isRead: true })
        .where(and(eq(messages.userId, user.id), eq(messages.isRead, false)))
        .returning({ id: messages.id });

      await db.commit();
      return { count: updated.length };
    });
  });
};
