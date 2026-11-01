/**
 * 三档角色体系 —— tests/test_role_manage.py
 *
 * pytest 的 class 分组 → vitest 的 describe 嵌套；fixture → beforeEach 里手工 seed。
 * `capsys` → `vi.spyOn(console, 'log')`。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { demoteSuper, promote } from '../../src/cli.js';
import { verifyAccessToken } from '../../src/auth/token.js';
import { buildTestApp, findAudit, findUser, request, seedUser, tokenFor } from './helpers.js';
import { resetDatabase } from './setup.js';
import type { User } from '../../src/db/schema.js';

let app: FastifyInstance;
let normalUser: User;
let admin: User;
let superadmin: User;

beforeEach(async () => {
  await resetDatabase();
  app ??= await buildTestApp();

  normalUser = await seedUser({ username: 'user1', password: 'Passw0rd!23' });
  admin = await seedUser({ username: 'admin1', password: 'Passw0rd!23', role: 'admin' });
  superadmin = await seedUser({ username: 'superadmin1', password: 'Passw0rd!23', role: 'superadmin' });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app?.close();
});

describe('requireAdmin', () => {
  it('admin 放行', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/users', user: admin });
    expect(response.statusCode).toBe(200);
  });

  it('superadmin 天然拥有管理员权限', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/users', user: superadmin });
    expect(response.statusCode).toBe(200);
  });

  it('普通用户 403', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/users', user: normalUser });
    expect(response.statusCode).toBe(403);
  });
});

describe('requireSuperadmin', () => {
  it('superadmin 放行，且列表里能看到自己的角色', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/manage/users', user: superadmin });
    expect(response.statusCode).toBe(200);

    const roles = new Map(
      response.json<readonly { username: string; role: string }[]>().map((u) => [u.username, u.role]),
    );
    expect(roles.get('superadmin1')).toBe('superadmin');
  });

  it('admin 403 且提示需要超级管理员', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/manage/users', user: admin });
    expect(response.statusCode).toBe(403);
    expect(response.json<{ detail: string }>().detail).toContain('超级管理员');
  });

  it('普通用户 403', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/manage/users', user: normalUser });
    expect(response.statusCode).toBe(403);
  });

  it('未认证 401', async () => {
    const response = await request(app, { method: 'GET', url: '/admin/manage/users' });
    expect(response.statusCode).toBe(401);
  });
});

describe('角色变更接口', () => {
  it('普通用户提升为管理员', async () => {
    const response = await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${normalUser.id}/role`,
      user: superadmin,
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ role: string }>().role).toBe('admin');
    expect((await findUser('user1'))?.role).toBe('admin');
  });

  it('管理员降为普通用户', async () => {
    const response = await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${admin.id}/role`,
      user: superadmin,
      payload: { role: 'user' },
    });
    expect(response.statusCode).toBe(200);
    expect((await findUser('admin1'))?.role).toBe('user');
  });

  it('接口层禁止授予 superadmin', async () => {
    const response = await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${normalUser.id}/role`,
      user: superadmin,
      payload: { role: 'superadmin' },
    });
    expect(response.statusCode).toBe(400);
    expect((await findUser('user1'))?.role).toBe('user');
  });

  it('非法角色值 400', async () => {
    const response = await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${normalUser.id}/role`,
      user: superadmin,
      payload: { role: 'root' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('禁止修改自己的角色', async () => {
    const response = await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${superadmin.id}/role`,
      user: superadmin,
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ detail: string }>().detail).toContain('自己');
  });

  it('禁止操作另一个超级管理员', async () => {
    const other = await seedUser({ username: 'super2', password: 'Passw0rd!23', role: 'superadmin' });

    const response = await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${other.id}/role`,
      user: superadmin,
      payload: { role: 'user' },
    });
    expect(response.statusCode).toBe(400);
    expect((await findUser('super2'))?.role).toBe('superadmin');
  });

  it('用户不存在 404', async () => {
    const response = await request(app, {
      method: 'PUT',
      url: '/admin/manage/users/99999/role',
      user: superadmin,
      payload: { role: 'admin' },
    });
    expect(response.statusCode).toBe(404);
  });

  it('角色未变化时幂等：不递增 password_version', async () => {
    const before = (await findUser('user1'))?.passwordVersion;

    const response = await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${normalUser.id}/role`,
      user: superadmin,
      payload: { role: 'user' },
    });
    expect(response.statusCode).toBe(200);
    expect((await findUser('user1'))?.passwordVersion).toBe(before);
  });

  it('角色变更后目标用户的旧 JWT 立即失效', async () => {
    const oldToken = tokenFor(normalUser);

    await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${normalUser.id}/role`,
      user: superadmin,
      payload: { role: 'admin' },
    });

    const response = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('角色变更写审计日志', async () => {
    await request(app, {
      method: 'PUT',
      url: `/admin/manage/users/${normalUser.id}/role`,
      user: superadmin,
      payload: { role: 'admin' },
    });

    const log = await findAudit('update_user_role');
    expect(log).toBeDefined();
    expect(log?.detail ?? '').toContain('user1');
    expect(log?.detail ?? '').toContain('admin');
  });
});

describe('服务器本地 CLI', () => {
  it('promote 提升普通用户', async () => {
    expect(await promote('user1')).toBe(0);
    expect((await findUser('user1'))?.role).toBe('superadmin');
  });

  it('promote 幂等并提示已是超级管理员', async () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });

    expect(await promote('superadmin1')).toBe(0);
    expect((await findUser('superadmin1'))?.role).toBe('superadmin');
    expect(logs.join('\n')).toContain('已是超级管理员');
  });

  it('promote 不存在的用户返回 1', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((message?: unknown) => {
      errors.push(String(message));
    });

    expect(await promote('no_such_user')).toBe(1);
    expect(errors.join('\n')).toContain('不存在');
  });

  it('promote 后旧 token 失效', async () => {
    const oldToken = tokenFor(normalUser);
    expect(await promote('user1')).toBe(0);

    const response = await request(app, {
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it('demote-super 降回管理员', async () => {
    expect(await demoteSuper('superadmin1')).toBe(0);
    expect((await findUser('superadmin1'))?.role).toBe('admin');
  });

  it('demote-super 对非超管是 no-op', async () => {
    expect(await demoteSuper('user1')).toBe(0);
    expect((await findUser('user1'))?.role).toBe('user');
  });

  it('CLI 变更写审计日志（操作人记为 server-cli）', async () => {
    await promote('user1');

    const log = await findAudit('cli_role_change');
    expect(log).toBeDefined();
    expect(log?.detail ?? '').toContain('server-cli');
  });
});

describe('JWT 角色声明', () => {
  it('token 携带 superadmin 角色', () => {
    const claims = verifyAccessToken(tokenFor(superadmin));
    expect(claims?.role).toBe('superadmin');
  });
});
