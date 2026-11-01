/**
 * 密码强度策略 + 注册/改密前置拦截 —— tests/test_password_policy.py
 *
 * pytest 的 `@pytest.mark.parametrize` → vitest 的 `it.each`；
 * `pytest.raises` → `expect(fn).toThrow(...)`。
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PasswordPolicyError, validatePasswordStrength,
} from '../../src/auth/password.js';
import { buildTestApp, request } from './helpers.js';
import { resetDatabase } from './setup.js';

let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestApp();
});

afterAll(async () => {
  await app?.close();
});

describe('密码强度（单元）', () => {
  it.each([
    ['Aa123456', '大写+小写+数字'],
    ['Abcdefg1', '大写+小写+数字'],
    ['Abcdefg!', '大写+小写+符号'],
    ['abcdef1!', '小写+数字+符号'],
    ['ABCDEF1!', '大写+数字+符号'],
    ['Aa1!aaaa', '四类齐全'],
    [`Aa1!${'x'.repeat(60)}`, '最大长度边界（64 位）'],
  ])('强密码通过: %s（%s）', (password) => {
    expect(() => validatePasswordStrength(password, 'someuser')).not.toThrow();
  });

  it.each([
    ['Aa12345', '长度不足 8 位'],
    ['A'.repeat(65), '长度超 64 位'],
    ['abcdefgh', '仅小写'],
    ['ABCDEFGH', '仅大写'],
    ['12345678', '仅数字'],
    ['aaaaaaaa', '仅一类字符'],
    ['Abcdefgh', '仅大写+小写两类'],
    ['abcd1234', '仅小写+数字两类'],
    ['ABCD1234', '仅大写+数字两类'],
    ['Aa  1234', '含空格'],
  ])('弱密码拒绝: %s（%s）', (password) => {
    expect(() => validatePasswordStrength(password, 'someuser')).toThrow(PasswordPolicyError);
  });

  it.each([
    ['john', 'John@2026xyz', '完整包含用户名'],
    ['JOHN', 'john@2026xyz', '大小写不敏感'],
    ['alice01', 'xAlice01@ab', '中间包含'],
  ])('密码含用户名被拒: %s / %s（%s）', (username, password) => {
    expect(() => validatePasswordStrength(password, username)).toThrow(/用户名/);
  });

  it('用户名不足 3 位时不做包含检查', () => {
    expect(() => validatePasswordStrength('Aa123456', 'ab')).not.toThrow();
  });

  it('长度按 Unicode 码点计数（emoji 不算 2 位）', () => {
    const password = `Aa1!${'\u{1F600}'.repeat(PASSWORD_MIN_LENGTH - 4)}`;
    expect([...password].length).toBe(PASSWORD_MIN_LENGTH);
    expect(() => validatePasswordStrength(password, 'someuser')).not.toThrow();

    const tooLong = `Aa1!${'x'.repeat(PASSWORD_MAX_LENGTH - 3)}`;
    expect(() => validatePasswordStrength(tooLong, 'someuser')).toThrow(PasswordPolicyError);
  });
});

describe('注册前置拦截', () => {
  it('弱密码 422，且不触达任何外部系统', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'weakpwd', password: 'abcdefgh' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toContain('三类');
  });

  it('密码包含用户名 422', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'robert', password: 'Robert@2026ab' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toContain('用户名');
  });

  it('长度不足在 schema 层即被拒（422）', async () => {
    const response = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username: 'robert', password: 'Aa123' },
    });
    expect(response.statusCode).toBe(422);
  });
});

describe('改密前置拦截', () => {
  const registerAndLogin = async (username: string, password: string): Promise<string> => {
    const registered = await request(app, {
      method: 'POST',
      url: '/auth/register',
      payload: { username, password },
    });
    expect(registered.statusCode).toBe(200);

    const login = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username, password },
    });
    expect(login.statusCode).toBe(200);
    return login.json<{ access_token: string }>().access_token;
  };

  it('弱新密码 422，且旧密码仍然可用', async () => {
    const token = await registerAndLogin('poluser', 'Oldpass123');

    const response = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { old_password: 'Oldpass123', new_password: 'weaknewpw' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json<{ detail: string }>().detail).toContain('三类');

    const again = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'poluser', password: 'Oldpass123' },
    });
    expect(again.statusCode).toBe(200);
  });

  it('强新密码改密成功，且旧 JWT 立即失效', async () => {
    const token = await registerAndLogin('poluser2', 'Oldpass123');

    const response = await request(app, {
      method: 'POST',
      url: '/auth/change-password',
      headers: { authorization: `Bearer ${token}` },
      payload: { old_password: 'Oldpass123', new_password: 'Newpass456' },
    });
    expect(response.statusCode).toBe(200);

    // 新密码可登录
    const relogin = await request(app, {
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'poluser2', password: 'Newpass456' },
    });
    expect(relogin.statusCode).toBe(200);

    // 改密后 passwordVersion 递增，旧 token 应被拒
    const stale = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(stale.statusCode).toBe(401);
  });
});
