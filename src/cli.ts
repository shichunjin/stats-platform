/**
 * 服务器本地管理命令 —— app/cli.py
 *
 * 超级管理员不允许通过任何 HTTP API 产生（见 routers/admin.ts 的 MANAGEABLE_ROLES），
 * 只能在服务器本机执行：
 *
 *   npm run cli -- promote <username>
 *   npm run cli -- demote-super <username>
 *
 * 与 Python 的差异：
 *  - argparse → 手写 argv 解析（子命令只有两个，引入依赖不划算；
 *    需要更多子命令时再换 `commander`）
 *  - SessionLocal / try-finally → `withSession()`，子进程退出前 `closeDatabase()`
 *  - `print(..., file=sys.stderr)` → `console.error`
 */
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { recordAudit } from './audit.js';
import type { DbSession } from './db/session.js';
import { withSession } from './db/session.js';
import { closeDatabase } from './db/client.js';
import { users, type UserRole } from './db/schema.js';
import './config/env.js';

export const VALID_ROLES: readonly UserRole[] = ['user', 'admin', 'superadmin'];

const USAGE = `用法: npm run cli -- <command> <username>

  promote <username>        将已有用户提升为超级管理员
  demote-super <username>   将超级管理员降回管理员（应急）

两个命令均幂等，并写入审计日志（操作人记录为 server-cli）。`;

/**
 * 提升为超级管理员。
 * `session` 仅供测试注入；生产不传，由函数自建会话并在结束时提交。
 */
export const promote = async (username: string, session?: DbSession): Promise<number> => {
  const apply = async (db: DbSession): Promise<number> => {
    const [user] = await db.db.select().from(users).where(eq(users.username, username)).limit(1);

    if (user === undefined) {
      console.error(`错误: 用户不存在: ${username}`);
      return 1;
    }
    if (user.role === 'superadmin') {
      console.log(`${username} 已是超级管理员，无需变更`);
      return 0;
    }

    const oldRole = user.role;
    // 角色变化后旧 JWT 立即失效（与 API 路径同一机制）
    await db.db.update(users)
      .set({ role: 'superadmin', passwordVersion: (user.passwordVersion ?? 1) + 1 })
      .where(eq(users.id, user.id));

    await recordAudit(db, {
      userId: user.id,
      action: 'cli_role_change',
      detail: `[server-cli] 角色由 ${oldRole} 提升为 superadmin`,
    });
    await db.commit();

    console.log(`OK: ${username} 已提升为超级管理员（旧登录态已失效，需重新登录）`);
    return 0;
  };

  return session === undefined ? withSession(apply) : apply(session);
};

/** 将超级管理员降回管理员（应急）。 */
export const demoteSuper = async (username: string, session?: DbSession): Promise<number> => {
  const apply = async (db: DbSession): Promise<number> => {
    const [user] = await db.db.select().from(users).where(eq(users.username, username)).limit(1);

    if (user === undefined) {
      console.error(`错误: 用户不存在: ${username}`);
      return 1;
    }
    if (user.role !== 'superadmin') {
      console.log(`${username} 当前角色为 ${user.role}，不是超级管理员，无需变更`);
      return 0;
    }

    await db.db.update(users)
      .set({ role: 'admin', passwordVersion: (user.passwordVersion ?? 1) + 1 })
      .where(eq(users.id, user.id));

    await recordAudit(db, {
      userId: user.id,
      action: 'cli_role_change',
      detail: '[server-cli] 角色由 superadmin 降级为 admin',
    });
    await db.commit();

    console.log(`OK: ${username} 已降级为管理员（旧登录态已失效，需重新登录）`);
    return 0;
  };

  return session === undefined ? withSession(apply) : apply(session);
};

export const main = async (argv: readonly string[]): Promise<number> => {
  const [command, username] = argv;

  if (command === undefined || username === undefined) {
    console.error(USAGE);
    return 2;
  }

  try {
    if (command === 'promote') return await promote(username);
    if (command === 'demote-super') return await demoteSuper(username);
    console.error(`错误: 未知命令: ${command}\n\n${USAGE}`);
    return 2;
  } finally {
    // main() 不注入会话，连接由 promote/demoteSuper 自建；进程退出前显式归还，
    // 否则 pg 池的 keep-alive 会挂住事件循环
    await closeDatabase();
  }
};

/* ---------------- 进程入口 ---------------- */

const isDirectRun = (): boolean => {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
};

if (isDirectRun()) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      console.error(error);
      process.exit(1);
    });
}
