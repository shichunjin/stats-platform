/**
 * 启动期一次性动作 —— app/main.py 模块级执行的那几段副作用
 *
 * Python 把这些写在 main.py 的 import 期（模块导入即执行），导致「只是想 import 一下
 * app」也会连库改表。TS 侧收敛为显式函数，由 server.ts / index.ts 主动调用。
 */
import { initDemoData } from './demo.js';
import { promoteBuiltinAdmin, runMigrations } from './migrate.js';

export const bootstrap = async (migrationsFolder?: string): Promise<void> => {
  await runMigrations(migrationsFolder);

  const promoted = await promoteBuiltinAdmin();
  if (promoted > 0) {
    // eslint-disable-next-line no-console
    console.info('已迁移: 内置 admin 账号提升为 superadmin');
  }

  await initDemoData();
};

export { initDemoData, promoteBuiltinAdmin, runMigrations };
