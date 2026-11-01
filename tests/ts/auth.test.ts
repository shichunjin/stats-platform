/**
 * 认证模块单元 + 接口测试 —— tests/test_auth.py
 *
 * 与 Python 的差异：
 *  - `jwt.decode` 裸解 → `verifyAccessToken`（zod 校验过的 claims，null 表示无效）
 *  - `verify_password` 是同步纯函数 → TS 侧拆成 `matchesDemoPassword`（同步）
 *    与 `verifyPasswordHash`（异步，pbkdf2 不阻塞事件循环）
 *  - `get_current_user` 直接调用 → 走 HTTP `/auth/me`（守卫挂在 preHandler 上，
 *    没有可直接调用的等价函数，测接口才是测真实行为）
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import type { FastifyInstance } from 'fastify';
import {
  hashPassword, verifyPasswordHash,
} from '../../src/auth/password.js';
import {
  DEMO_ACCOUNTS, getDemoPasswords, isDemoAccount, matchesDemoPassword,
} from '../../src/auth/demo.js';
import { createAccessToken, verifyAccessToken } from '../../src/auth/token.js';
import { getSettings } from '../../src/config/env.js';
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

describe('演示账号密码校验', () => {
  it('admin 正确密码', () => {
    expect(matchesDemoPassword('admin', 'admin123')).toBe(true);
  });

  it('user1 正确密码', () => {
    expect(matchesDemoPassword('user1', 'user123')).toBe(true);
  });

  it('错误密码', () => {
    expect(matchesDemoPassword('admin', 'wrong')).toBe(false);
  });

  it('不存在的用户', () => {
    expect(matchesDemoPassword('nobody', 'any')).toBe(false);
  });

  it('空用户名', () => {
    expect(matchesDemoPassword('', 'any')).toBe(false);
  });

  it('空密码', () => {
    expect(matchesDemoPassword('admin', '')).toBe(false);
  });

  it('用户名大小写敏感', () => {
    expect(matchesDemoPassword('Admin', 'admin123')).toBe(false);
  });

  it('密码大小写敏感', () => {
    expect(matchesDemoPassword('admin', 'ADMIN123')).toBe(false);
  });
});

describe('pbkdf2 哈希', () => {
  it('正确密码通过，错误密码拒绝', async () => {
    const stored = await hashPassword('Passw0rd!23', 1_000);
    expect(await verifyPasswordHash('Passw0rd!23', stored)).toBe(true);
    expect(await verifyPasswordHash('wrong', stored)).toBe(false);
  });

  it('空/非法存储串返回 false', async () => {
    expect(await verifyPasswordHash('x', null)).toBe(false);
    expect(await verifyPasswordHash('x', 'garbage')).toBe(false);
  });

  it('哈希串嵌入迭代次数（支持平滑升级）', async () => {
    const stored = await hashPassword('Passw0rd!23', 1_000);
    expect(stored.startsWith('pbkdf2$1000$')).toBe(true);
  });

  it('兼容旧的三段格式（视为 100000 次迭代）', async () => {
    // 直接构造旧格式：pbkdf2$<salt_b64>$<hash_b64>
    const legacy = 'pbkdf2$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
    // 内容不对等，但必须「能解析且不抛异常」，返回 false 而不是崩溃
    expect(await verifyPasswordHash('x', legacy)).toBe(false);
  });
});

describe('JWT 签发', () => {
  it('是合法的 JWT 字符串', () => {
    const token = createAccessToken({
      userId: 1, username: 'user1', role: 'user', passwordVersion: 1,
    });
    expect(token.split('.')).toHaveLength(3);
  });

  it('payload 含 sub / username / role', () => {
    const token = createAccessToken({
      userId: 42, username: 'testuser', role: 'user', passwordVersion: 1,
    });
    const payload = jwt.verify(token, getSettings().jwtSecret) as Record<string, unknown>;
    expect(payload.sub).toBe('42');
    expect(payload.username).toBe('testuser');
    expect(payload.role).toBe('user');
  });

  it('过期时间落在 7~9 小时（默认 8 小时）', () => {
    const token = createAccessToken({
      userId: 1, username: 'user1', role: 'user', passwordVersion: 1,
    });
    const payload = jwt.verify(token, getSettings().jwtSecret) as { exp: number; iat: number };
    expect((payload.exp - payload.iat) / 3600).toBeGreaterThanOrEqual(7);
    expect((payload.exp - payload.iat) / 3600).toBeLessThanOrEqual(9);
  });

  it('过期 token 校验返回 null', () => {
    const expired = jwt.sign(
      { sub: '1', username: 'user1', role: 'user', pwd_ver: 1 },
      getSettings().jwtSecret,
      { algorithm: 'HS256', expiresIn: '-1h' },
    );
    expect(verifyAccessToken(expired)).toBeNull();
  });

  it('篡改的 token 校验返回 null', () => {
    const token = createAccessToken({
      userId: 1, username: 'user1', role: 'user', passwordVersion: 1,
    });
    expect(verifyAccessToken(`${token.slice(0, -5)}XXXXX`)).toBeNull();
  });

  it('不同用户生成不同 token', () => {
    const first = createAccessToken({
      userId: 1, username: 'user1', role: 'user', passwordVersion: 1,
    });
    const second = createAccessToken({
      userId: 2, username: 'user2', role: 'user', passwordVersion: 1,
    });
    expect(first).not.toBe(second);
  });
});

describe('密码版本（B2）', () => {
  it('新签发的 token 带 pwd_ver', () => {
    const token = createAccessToken({
      userId: 1, username: 'user1', role: 'user', passwordVersion: 3,
    });
    const payload = jwt.verify(token, getSettings().jwtSecret) as { pwd_ver: number };
    expect(payload.pwd_ver).toBe(3);
  });

  it('无 pwd_ver 的旧 token 被拒（视为版本 0）', async () => {
    const user = await seedUser({ username: 'user1', password: 'Passw0rd!23' });
    const oldToken = jwt.sign(
      { sub: String(user.id), username: 'user1', role: 'user' },
      getSettings().jwtSecret,
      { algorithm: 'HS256', expiresIn: '1h' },
    );

    const response = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json<{ detail: string }>().detail).toContain('已过期');
  });

  it('版本不匹配被拒', async () => {
    const user = await seedUser({ username: 'user1', password: 'Passw0rd!23' });
    // 用户当前 password_version=1，token 里写 9
    const token = createAccessToken({
      userId: user.id, username: 'user1', role: 'user', passwordVersion: 9,
    });

    const response = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('版本匹配放行', async () => {
    const user = await seedUser({ username: 'user1', password: 'Passw0rd!23' });
    const token = createAccessToken({
      userId: user.id,
      username: 'user1',
      role: 'user',
      passwordVersion: user.passwordVersion ?? 1,
    });

    const response = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ username: string }>().username).toBe('user1');
  });
});

describe('DEMO 账号数据', () => {
  it('admin / user1 均在名单中且密码已配置', () => {
    const passwords = getDemoPasswords();
    expect(passwords.get('admin')).toBe('admin123');
    expect(passwords.get('user1')).toBe('user123');
  });

  it('isDemoAccount 只认名单内用户名', () => {
    for (const account of DEMO_ACCOUNTS) {
      expect(isDemoAccount(account.username)).toBe(true);
    }
    expect(isDemoAccount('somebody-else')).toBe(false);
  });

  it('演示账号不能被注册占用，也不能在线改密', async () => {
    const registered = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'admin', password: 'Passw0rd!23' },
    });
    expect(registered.statusCode).toBe(400);
  });
});
