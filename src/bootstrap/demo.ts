/**
 * 演示账号初始化 —— app/main.py 的 `_init_demo_data()`
 *
 * 两段逻辑，与 Python 一一对应：
 *  1. 建号：DEMO_ACCOUNTS 中「已配置密码」的账号不存在时插入（无 password_hash，
 *     登录时走 DEMO_USERS 字典校验）
 *  2. 收敛：若开启 Guacamole 同步，每次启动都以 .env 中的演示密码为准，
 *     先同步 Windows 本地账号、再同步 Guacamole 用户（失败只告警不阻断启动）
 */
import { eq } from 'drizzle-orm';
import { DEMO_ACCOUNTS, getDemoPasswords } from '../auth/demo.js';
import { users } from '../db/schema.js';
import { withSession } from '../db/session.js';
import { upsertGuacUser, guacSyncEnabled } from '../integrations/guac.js';
import { syncWindowsUser, windowsSyncEnabled } from '../integrations/windows-account.js';

const log = (message: string, error?: unknown): void => {
  // eslint-disable-next-line no-console
  console.warn(`[demo] ${message}`, error ?? '');
};

const createMissingDemoUsers = async (): Promise<void> => {
  const passwords = getDemoPasswords();

  await withSession(async (db) => {
    for (const account of DEMO_ACCOUNTS) {
      // 未配置密码的演示账号整体跳过（对应 Python 的 `if username not in DEMO_USERS`）
      if (!passwords.has(account.username)) continue;

      const [existing] = await db.db.select({ id: users.id }).from(users)
        .where(eq(users.username, account.username))
        .limit(1);
      if (existing !== undefined) continue;

      await db.db.insert(users).values({
        username: account.username,
        displayName: account.displayName,
        role: account.role,
        isActive: true,
      });
    }
    await db.commit();
  });
};

/**
 * 顺序与注册链路一致：先 Windows 后 Guacamole。
 * Windows 失败则跳过本次 Guacamole 更新，避免三端凭据分叉。
 */
const syncDemoAccounts = async (): Promise<void> => {
  if (!guacSyncEnabled()) return;

  const winSync = windowsSyncEnabled();
  for (const [username, password] of getDemoPasswords()) {
    if (winSync) {
      try {
        await syncWindowsUser(username, password);
      } catch (error) {
        log(`演示账号 ${username} 同步 Windows 失败，跳过本次 Guacamole 同步`, error);
        continue;
      }
    }
    try {
      await upsertGuacUser(username, password);
    } catch (error) {
      log(`演示账号 ${username} 同步 Guacamole 失败`, error);
    }
  }
};

export const initDemoData = async (): Promise<void> => {
  await createMissingDemoUsers();
  await syncDemoAccounts();
};
