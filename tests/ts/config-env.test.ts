/**
 * 配置层校验 —— 对应 Python `app/config.py` 的 fail-fast 语义
 *
 * 重点覆盖 DATABASE_URL：服务器上曾因 `.env` 沿用 `postgresql+psycopg2://`
 * （SQLAlchemy 驱动后缀，`pg` 驱动不认）导致启动即崩，且原报错文案完全指不出方向。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigError, createSettings, takeConfigWarnings } from '../../src/config/env.js';

/** 除被测字段外的最小合法配置：jwtSecret 是唯一没有默认值的必填项 */
const BASE: Record<string, string> = { JWT_SECRET: 'test-secret-not-a-real-one' };

const parseUrl = (databaseUrl: string) => createSettings({ ...BASE, DATABASE_URL: databaseUrl });

describe('DATABASE_URL 方言校验', () => {
  beforeEach(() => {
    // 模块加载时的那次解析也会产生告警，先排空，避免跨用例串味
    takeConfigWarnings();
  });

  it('postgres:// 与 postgresql:// 都直接通过', () => {
    expect(parseUrl('postgres://u:p@127.0.0.1:5432/db').databaseUrl)
      .toBe('postgres://u:p@127.0.0.1:5432/db');
    expect(parseUrl('postgresql://u:p@127.0.0.1:5432/db').databaseUrl)
      .toBe('postgresql://u:p@127.0.0.1:5432/db');
  });

  it('pglite:// 放行（测试替身经 pglite-socket 暴露 wire 协议）', () => {
    expect(parseUrl('pglite://memory').databaseUrl).toBe('pglite://memory');
  });

  it('SQLAlchemy 驱动后缀被自动剥离，不再阻断启动', () => {
    expect(parseUrl('postgresql+psycopg2://u:p@h:5432/db').databaseUrl)
      .toBe('postgresql://u:p@h:5432/db');
    expect(parseUrl('postgres+asyncpg://u:p@h:5432/db').databaseUrl)
      .toBe('postgres://u:p@h:5432/db');
  });

  it('剥离驱动后缀会留一条告警，且告警里不含数据库密码', () => {
    parseUrl('postgresql+psycopg2://stats:super_secret_pwd@127.0.0.1:5432/stats_platform');

    const [warning] = takeConfigWarnings();
    expect(warning).toContain('驱动后缀');
    expect(warning).not.toContain('super_secret_pwd');
    expect(warning).toContain('***');
  });

  it('没有问题时 takeConfigWarnings 为空，且取走后即清空', () => {
    parseUrl('postgresql://u:p@h:5432/db');
    expect(takeConfigWarnings()).toEqual([]);

    parseUrl('postgresql+psycopg2://u:p@h:5432/db');
    expect(takeConfigWarnings()).toHaveLength(1);
    expect(takeConfigWarnings()).toEqual([]);
  });

  it('sqlite:// 报「不再支持 SQLite」并指向迁移脚本', () => {
    expect(() => parseUrl('sqlite:///./stats_platform.db'))
      .toThrow(/不再支持 SQLite/);
  });

  it('其他方言报「仅支持 PostgreSQL」并给出正确格式', () => {
    expect(() => parseUrl('mysql://u:p@h:3306/db')).toThrow(/仅支持 PostgreSQL/);
  });
});

describe('ConfigError', () => {
  beforeEach(() => {
    takeConfigWarnings();
  });

  it('同时带上环境变量名与字段名，便于对着 .env 逐条改', () => {
    try {
      createSettings({ ...BASE, DATABASE_URL: 'mysql://u:p@h/db' });
      expect.unreachable('期望抛出 ConfigError');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const { issues } = error as ConfigError;
      expect(issues).toHaveLength(1);
      expect(issues[0]?.envName).toBe('DATABASE_URL');
      expect(issues[0]?.field).toBe('databaseUrl');
    }
  });

  it('jwtSecret 缺失也是 fail-fast，不回落到硬编码默认值', () => {
    expect(() => createSettings({ DATABASE_URL: 'postgresql://u:p@h:5432/db' }))
      .toThrow(ConfigError);
  });
});
