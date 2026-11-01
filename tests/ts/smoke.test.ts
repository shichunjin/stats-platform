/**
 * 冒烟测试：验证「Fastify + Drizzle + PGlite」整条链路真的能跑起来。
 *
 * Python 侧没有对应文件（它的等价物是整个 test_api.py 的第一段），
 * 这里单独拎出来，因为迁移期最需要先证明的是基础设施而不是业务断言。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildTestApp, request, seedUser } from './helpers.js';
import { resetDatabase } from './setup.js';

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe('基础链路', () => {
  it('健康检查无需认证', async () => {
    const response = await request(app, { method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('未携带 token 的受保护接口返回 401', async () => {
    const response = await request(app, { method: 'GET', url: '/auth/me' });
    expect(response.statusCode).toBe(401);
  });

  it('注册 → 登录 → me 全链路通畅，且 wire 字段是 snake_case', async () => {
    const registered = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'alice', password: 'Passw0rd!23', display_name: '爱丽丝' },
    });
    expect(registered.statusCode).toBe(200);

    const login = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'alice', password: 'Passw0rd!23' },
    });
    expect(login.statusCode).toBe(200);

    const token = login.json<{ access_token: string }>().access_token;
    expect(token).toBeTypeOf('string');

    const me = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      username: 'alice',
      display_name: '爱丽丝',
      role: 'user',
    });
  });

  it('密码错误返回 401，且不泄露用户是否存在', async () => {
    await seedUser({ username: 'bob', password: 'Passw0rd!23' });

    const response = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'bob', password: 'wrong-password' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toBe('用户名或密码错误');
  });

  it('管理员接口对普通用户返回 403', async () => {
    const user = await seedUser({ username: 'carol', password: 'Passw0rd!23' });

    const response = await request(app, {
      method: 'GET',
      url: '/admin/audit',
      user,
    });
    expect(response.statusCode).toBe(403);
  });
});
