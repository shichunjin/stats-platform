/**
 * 演示账号 —— app/auth.py:22-32
 *
 * 改为惰性函数：settings 是可变单例（conftest 会覆盖），
 * 模块级快照会让覆盖失效。Python 版是模块级构建的，这里是有意的行为改进。
 */
import { getSettings } from '../config/env.js';
import type { UserRole } from '../db/schema.js';
import { safeEqualString } from './password.js';

export interface DemoAccount {
  readonly username: string;
  readonly displayName: string;
  readonly role: UserRole;
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { username: 'admin', displayName: '超级管理员', role: 'superadmin' },
  { username: 'user1', displayName: '测试用户1', role: 'user' },
];

/** 当前启用的演示账号密码（未配置即禁用） */
export const getDemoPasswords = (): ReadonlyMap<string, string> => {
  const { demoAdminPassword, demoUserPassword } = getSettings();
  const passwords = new Map<string, string>();
  if (demoAdminPassword) passwords.set('admin', demoAdminPassword);
  if (demoUserPassword) passwords.set('user1', demoUserPassword);
  return passwords;
};

export const isDemoAccount = (username: string): boolean =>
  DEMO_ACCOUNTS.some((account) => account.username === username);

export const findDemoAccount = (username: string): DemoAccount | undefined =>
  DEMO_ACCOUNTS.find((account) => account.username === username);

/** 演示账号密码比对（常量时间，防时序侧信道 —— 对应 hmac.compare_digest） */
export const matchesDemoPassword = (username: string, password: string): boolean => {
  const expected = getDemoPasswords().get(username);
  return expected === undefined ? false : safeEqualString(expected, password);
};
