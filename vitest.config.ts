/**
 * vitest 配置 —— 对应 pytest.ini + tests/conftest.py 的进程级部分
 *
 * 关键决策：测试数据库用 PGlite（编译成 WASM 的真实 PostgreSQL），
 * 经 @electric-sql/pglite-socket 暴露 PG wire 协议，让业务代码里的 `pg` Pool
 * 与 drizzle 完全不改一行就能连上。
 *
 * Python 侧用的是 SQLite 内存库；TS 侧只支持 PostgreSQL（见 src/db/client.ts），
 * 所以不能照搬。PGlite 是真实 PG，因此 FOR UPDATE / SAVEPOINT / 部分唯一索引
 * 这些 SQLite 下会静默失效的特性，在测试里也是真生效的 —— 比原方案更接近生产。
 *
 * ⚠️ 环境变量必须写在 `test.env` 里，而不是 setup.ts 顶部：
 * ESM 的 import 会先于模块体执行，setup.ts 里再赋值已经晚了 —— src/config/env.ts
 * 在 import 阶段就会因为缺 DATABASE_URL 抛 ConfigError。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from 'vitest/config';

const FILESERVER_ROOT = mkdtempSync(join(tmpdir(), 'stats_test_'));

const TEST_JWT_SECRET = 'test-secret-key-for-unit-tests';
const TEST_DEMO_ADMIN_PASSWORD = 'admin123';
const TEST_DEMO_USER_PASSWORD = 'user123';
/** 不可路由地址：打开同步开关后也不会真的发起 SSH 连接 */
const TEST_SFTP_HOST = '10.99.0.1';

export default defineConfig({
  test: {
    env: {
      // 占位：真实连接串由 tests/ts/setup.ts 起好 PGlite 后 overrideSettings 覆盖
      DATABASE_URL: 'postgres://postgres@127.0.0.1:1/postgres',
      APP_ENV: 'dev',
      JWT_SECRET: TEST_JWT_SECRET,
      DEMO_ADMIN_PASSWORD: TEST_DEMO_ADMIN_PASSWORD,
      DEMO_USER_PASSWORD: TEST_DEMO_USER_PASSWORD,
      FILESERVER_ROOT,
      // 测试环境不连真实 Windows 云主机
      WINDOWS_ACCOUNT_SYNC: 'false',
      // B1：全部用例发自同一 client IP，会误触阈值
      RATE_LIMIT_ENABLED: 'false',
      // 防止读到生产 .env 里真实的 Guacamole 库连接串
      GUAC_DB_URL: '',
      SFTP_HOST: TEST_SFTP_HOST,
      SFTP_KEY_PATH: join(FILESERVER_ROOT, '__missing_key__'),
      // 基线固定为不存在的路径：相似度规则下「无基线」安全默认转人工审核，
      // 使既有用例的审批流程断言保持确定性（相似度专项用例自行覆盖）
      DATASET_CSV_PATH: join(FILESERVER_ROOT, '__missing_baseline__.csv'),
    },
    include: ['tests/ts/**/*.test.ts'],
    setupFiles: ['tests/ts/setup.ts'],
    // 一个 PGlite 实例被所有用例共享，无法并行（pytest 默认也是串行）
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30_000,
    hookTimeout: 60_000,
    environment: 'node',
    globals: false,
  },
});
