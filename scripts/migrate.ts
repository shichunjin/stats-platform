/**
 * 手动应用迁移 —— `npm run db:migrate`
 *
 * 服务启动时（src/bootstrap/index.ts）已经会自动跑一次，这个脚本用于
 * 「先迁移再起服务」的部署流程，或 CI 里的独立迁移步骤。
 */
import { closeDatabase } from '../src/db/client.js';
import { promoteBuiltinAdmin, runMigrations } from '../src/bootstrap/migrate.js';

const main = async (): Promise<void> => {
  await runMigrations();
  console.log('[migrate] schema 迁移完成');

  const promoted = await promoteBuiltinAdmin();
  if (promoted > 0) {
    console.log('[migrate] 内置 admin 账号已提升为 superadmin');
  }
};

main()
  .catch((error: unknown) => {
    console.error('[migrate] 失败', error);
    process.exitCode = 1;
  })
  .finally(() => { void closeDatabase(); });
