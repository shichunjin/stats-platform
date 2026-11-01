/**
 * 测试夹具 —— tests/conftest.py 的 fixture 部分
 *
 * pytest 用 fixture + monkeypatch；vitest 用普通函数 + `vi.mock`。
 * 这里只放「不需要 mock」的夹具（建 app、建用户、签发 token），
 * 需要替换外部系统调用的用例在各自文件里用 vi.mock 处理。
 */
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword } from '../../src/auth/password.js';
import { createAccessToken } from '../../src/auth/token.js';
import { auditLogs, users, type AuditLog, type User, type UserRole } from '../../src/db/schema.js';
import { withSession } from '../../src/db/session.js';
import { buildApp } from '../../src/server.js';

export const buildTestApp = (): Promise<FastifyInstance> =>
  buildApp({ skipBootstrap: true, logger: false });

export interface SeedUserOptions {
  readonly username: string;
  readonly displayName?: string;
  readonly role?: UserRole;
  /** 传了才写 password_hash（演示账号的行为：哈希为空） */
  readonly password?: string;
  readonly isActive?: boolean;
}

export const seedUser = async (options: SeedUserOptions): Promise<User> =>
  withSession(async (db) => {
    const [row] = await db.db.insert(users).values({
      username: options.username,
      displayName: options.displayName ?? options.username,
      role: options.role ?? 'user',
      isActive: options.isActive ?? true,
      passwordHash: options.password === undefined ? null : await hashPassword(options.password),
    }).returning();

    await db.commit();
    return row!;
  });

/** 重新读一次用户（替代 SQLAlchemy 的 session.refresh） */
export const findUser = async (username: string): Promise<User | undefined> =>
  withSession(async (db) => {
    const [row] = await db.db.select().from(users)
      .where(eq(users.username, username))
      .limit(1);
    return row;
  });

/** 查最近一条审计日志（按 id 倒序） */
export const findAudit = async (action: string): Promise<AuditLog | undefined> =>
  withSession(async (db) => {
    const [row] = await db.db.select().from(auditLogs)
      .where(eq(auditLogs.action, action))
      .limit(1);
    return row;
  });

export const tokenFor = (user: User): string => createAccessToken({
  userId: user.id,
  username: user.username,
  role: user.role,
  passwordVersion: user.passwordVersion ?? 1,
});

/** 生成 Authorization 头；传 null 表示不携带（测未认证路径） */
export const authHeaders = (user: User | null): Record<string, string> =>
  user === null ? {} : { authorization: `Bearer ${tokenFor(user)}` };

export interface InjectOptions {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  readonly url: string;
  readonly user?: User | null;
  readonly payload?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface InjectResponse {
  readonly statusCode: number;
  /** 响应头（底层是 IncomingHttpHeaders；测试里一律按字符串取值，故在此收窄） */
  readonly headers: Readonly<Record<string, string>>;
  readonly json: <T = unknown>() => T;
  readonly body: string;
  /** 原始响应字节：断言二进制下载内容时用（Fastify inject 的 rawPayload） */
  readonly rawPayload: Buffer;
}

/** Fastify 内置的 app.inject 等价 fastapi TestClient（底层都是 light-my-request） */
export const request = async (
  app: FastifyInstance,
  options: InjectOptions,
): Promise<InjectResponse> => {
  const response = await app.inject({
    method: options.method,
    url: options.url,
    headers: { ...authHeaders(options.user ?? null), ...(options.headers ?? {}) },
    payload: options.payload as Record<string, unknown> | undefined,
  });

  return {
    statusCode: response.statusCode,
    headers: response.headers as Record<string, string>,
    json: <T = unknown>() => response.json<T>(),
    body: response.body,
    rawPayload: response.rawPayload,
  };
};
