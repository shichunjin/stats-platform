/**
 * 启动期 schema 迁移与数据迁移 —— app/main.py 的 `_migrate_schema()`
 *
 * Python 侧因为用的是 `Base.metadata.create_all()` + 手写裸 SQL，才需要
 * 一大段「列不存在就 ALTER TABLE」的兜底逻辑。TS 侧 schema 由 Drizzle 拥有，
 * 迁移改为 drizzle-kit 生成的版本化 SQL：
 *
 *   npm run db:generate   # 依据 src/db/schema.ts 生成 drizzle/xxxx.sql
 *   npm run db:migrate    # 应用迁移（本文件在启动时自动执行同一件事）
 *
 * 因此下列 Python 迁移在 TS 侧**不再需要**，已在注释中留痕：
 *  - users.password_version / pending_files.content_sha / data_applies.filters
 *    → 已在 schema.ts 中声明，迁移文件自带
 *  - sessions.software 的 DROP COLUMN（含旧 SQLite 重建表兜底）
 *    → TS 侧只支持 PostgreSQL，schema 里根本没有该列，一次 DROP 迁移即可
 *  - ix_pending_files_active 部分唯一索引
 *    → 下沉到 schema.ts（见该文件注释）
 *
 * 唯一保留的是**数据迁移**：内置 admin 提升为 superadmin。
 */
import { and, eq } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { withSession } from '../db/session.js';

export const MIGRATIONS_FOLDER = 'drizzle';

/**
 * 应用待执行的迁移文件。
 *
 * 与 Python 的差异：`migrate()` 自带事务与「已应用」记录表（drizzle.__drizzle_migrations），
 * 不需要自己写 `CREATE TABLE IF NOT EXISTS`。
 */
export const runMigrations = async (folder: string = MIGRATIONS_FOLDER): Promise<void> => {
  await migrate(getDb(), { migrationsFolder: folder });
};

/**
 * 角色三档化的数据迁移：把内置的 admin 账号提升为 superadmin（幂等）。
 *
 * 只命中 username='admin' 且当前 role='admin' 的行，其他管理员不受影响；
 * 每次启动都执行，但第二次起 rowCount 为 0，不产生额外写。
 */
export const promoteBuiltinAdmin = async (): Promise<number> =>
  withSession(async (db) => {
    const updated = await db.db.update(users)
      .set({ role: 'superadmin' })
      .where(and(eq(users.username, 'admin'), eq(users.role, 'admin')))
      .returning({ id: users.id });

    await db.commit();
    return updated.length;
  });
