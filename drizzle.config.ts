/**
 * drizzle-kit 配置 —— 取代 app/main.py 里那段「启动时裸 SQL 建表/改表」
 *
 * 常用命令见 package.json：
 *   npm run db:generate   依据 src/db/schema.ts 生成版本化 SQL 到 drizzle/
 *   npm run db:migrate    应用迁移（服务启动时也会自动跑一次）
 *   npm run db:push       开发期直接把 schema 推到库（不改迁移文件，慎用）
 *   npm run db:studio     可视化查看数据
 */
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// 只做「读 .env 拿 DATABASE_URL」，不走 src/config/env.js —— 后者会做 fail-fast
// 校验，drizzle-kit 在没有完整 .env 的 CI 环境下不该被配置校验挡住
config();

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // 中文列名/部分索引等需要人工复核，生成后务必 diff 一遍 SQL
  verbose: true,
  strict: true,
});
