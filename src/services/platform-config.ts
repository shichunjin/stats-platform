/**
 * 平台连接配置（C4）—— 管理端「连接数据分析PC」保存真正落库。
 * 密码永不落库：测试连接时临时输入，仅用于当次 SSH 探测。
 */
import { eq } from 'drizzle-orm';
import { getSettings } from '../config/env.js';
import { platformConfig } from '../db/schema.js';
import type { DbSession } from '../db/session.js';

export const PLATFORM_CONFIG_KEYS = ['host', 'port', 'username', 'workspace_dir', 'output_path'] as const;
export type PlatformConfigKey = (typeof PLATFORM_CONFIG_KEYS)[number];

export interface PlatformConfigView {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly workspace_dir: string;
  readonly output_path: string;
}

const loadStored = async (db: DbSession): Promise<Map<string, string | null>> => {
  const rows = await db.db.select().from(platformConfig);
  return new Map(rows.map((row) => [row.key, row.value]));
};

/** 读取配置（库优先，环境变量兜底）。密码永不返回 */
export const readPlatformConfig = async (db: DbSession): Promise<PlatformConfigView> => {
  const {
    sftpHost, sftpPort, sftpUsername, windowsWorkspaceDir, windowsDataDir,
  } = getSettings();
  const stored = await loadStored(db);

  const portFromDb = Number(stored.get('port') ?? '');
  return {
    host: stored.get('host') || sftpHost,
    port: Number.isInteger(portFromDb) && portFromDb > 0 ? portFromDb : sftpPort,
    username: stored.get('username') || sftpUsername,
    workspace_dir: stored.get('workspace_dir') || windowsWorkspaceDir,
    output_path: stored.get('output_path') || windowsDataDir,
  };
};

/** 数据生成投递目录：平台配置库优先，环境变量兜底（供 data 生成任务调用） */
export const getWorkspaceRoot = async (db: DbSession): Promise<string> => {
  const [row] = await db.db.select().from(platformConfig)
    .where(eq(platformConfig.key, 'workspace_dir')).limit(1);
  return row?.value || getSettings().windowsWorkspaceDir;
};

export const savePlatformConfig = async (
  db: DbSession,
  values: Readonly<Record<PlatformConfigKey, string>>,
  updatedBy: number,
): Promise<void> => {
  for (const key of PLATFORM_CONFIG_KEYS) {
    const value = values[key];
    await db.db.insert(platformConfig)
      .values({ key, value, updatedBy })
      .onConflictDoUpdate({
        target: platformConfig.key,
        set: { value, updatedBy },
      });
  }
};
