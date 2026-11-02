/**
 * SFTP 文件传输 —— app/transfer.py
 *
 * Python 用 paramiko（同步阻塞）；TS 用 ssh2（全异步回调）。
 * 所有 API 都返回 Promise，调用方必须 await —— 这也意味着调用它的路由
 * 不再占用线程，Node 下反而是性能收益。
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  Client as SshClient, type ClientChannel, type FileEntryWithStats, type SFTPWrapper,
} from 'ssh2';
import iconv from 'iconv-lite';
import { getSettings } from '../config/env.js';

/** 与 Windows 本地账号规则一致；lock_owner 会进入远程命令，必须白名单校验 */
const OWNER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,19}$/;

const CONNECT_TIMEOUT_MS = 15_000;
const EXEC_TIMEOUT_MS = 25_000;
const ICACLS_TIMEOUT_MS = 20_000;

export interface ExecResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

/** 中文版 Windows 的 stderr 通常是 GBK；Node 无内置 GBK 解码器，需 iconv-lite */
export const decodeRemote = (data: Buffer): string => {
  for (const encoding of ['utf8', 'gbk', 'latin1'] as const) {
    const text = iconv.decode(data, encoding);
    // GBK 几乎能解码任意字节流，无法靠异常判定；用替换字符比例做兜底判断
    if (!text.includes('\uFFFD')) return text;
  }
  return iconv.decode(data, 'latin1');
};

const expandHome = (value: string): string =>
  value.startsWith('~') ? join(homedir(), value.slice(1)) : value;

export class TransferError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'TransferError';
  }
}

/**
 * 建立 SSH 连接（密钥免密）。调用方负责 close()。
 *
 * ⚠️ 安全说明：Python 版用 AutoAddPolicy（等价于无中间人防护）。这里保留了
 * 同样的首次信任行为，但把它收敛到单一回调并每次告警 —— 后续若配置
 * SFTP_KNOWN_HOSTS，只需替换这个函数体。
 *
 * **host 参数（云桌面改造）**：原本只连 settings.sftpHost（中心文件服务器）。
 * 多 VM 后账号同步还要连「用户自己的 VM」，故允许覆盖目标主机；不传 = 沿用现状。
 */
export const connectSsh = async (host?: string): Promise<SshClient> => {
  const { sftpHost, sftpPort, sftpUsername, sftpKeyPath, sftpPassphrase } = getSettings();

  const keyPath = expandHome(sftpKeyPath);
  if (!existsSync(keyPath)) {
    throw new TransferError(`SFTP 私钥不存在: ${keyPath}`);
  }

  const ssh = new SshClient();

  await new Promise<void>((resolve, reject) => {
    const onReady = (): void => resolve();
    ssh.once('ready', onReady);
    ssh.once('error', (error: Error) => reject(new TransferError('SSH 连接失败', error)));

    ssh.connect({
      host: host ?? sftpHost,
      port: sftpPort,
      username: sftpUsername,
      privateKey: readFileSync(keyPath),
      passphrase: sftpPassphrase || undefined,
      readyTimeout: CONNECT_TIMEOUT_MS,
      agentForward: false,
      // 首次信任（等价 AutoAddPolicy）；指纹变化不会告警是已知弱点
      hostVerifier: (key: Buffer) => {
        console.warn('[ssh] 首次连接主机，已自动信任其指纹（未启用 known_hosts 校验）');
        return key.length > 0;
      },
    });
  });

  return ssh;
};

/** 执行远程命令；stdin 可选（用于从 stdin 传脚本，绕开命令行长度限制） */
export const execCommand = async (
  ssh: SshClient,
  command: string,
  options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
): Promise<ExecResult> =>
  new Promise<ExecResult>((resolve, reject) => {
    ssh.exec(command, (error: Error | undefined, channel: ClientChannel) => {
      if (error || !channel) {
        reject(new TransferError('远程命令执行失败', error));
        return;
      }

      const chunks: Buffer[] = [];
      const errorChunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        channel.close();
        reject(new TransferError(`远程命令超时（${options.timeoutMs ?? EXEC_TIMEOUT_MS}ms）`));
      }, options.timeoutMs ?? EXEC_TIMEOUT_MS);

      channel.on('data', (chunk: Buffer) => chunks.push(chunk));
      channel.stderr.on('data', (chunk: Buffer) => errorChunks.push(chunk));
      channel.on('error', (channelError: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new TransferError('远程通道异常', channelError));
      });
      channel.on('close', (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ code, stdout: Buffer.concat(chunks), stderr: Buffer.concat(errorChunks) });
      });

      if (options.stdin !== undefined) channel.write(options.stdin);
      channel.end();
    });
  });

/** 统一的资源作用域：保证 sftp/ssh 一定被关闭 */
export const withSftp = async <T>(
  fn: (sftp: SFTPWrapper) => Promise<T>,
): Promise<T> => {
  const ssh = await connectSsh();
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      ssh.sftp((error, handle) => (error || !handle ? reject(new TransferError('SFTP 通道建立失败', error)) : resolve(handle)));
    });
    try {
      return await fn(sftp);
    } finally {
      sftp.end();
    }
  } finally {
    ssh.end();
  }
};

/** 递归创建远端目录（mkdir -p 语义），已存在则跳过 */
export const ensureRemoteDir = async (
  sftp: SFTPWrapper,
  remoteDir: string,
): Promise<void> => {
  const parts = remoteDir.replace(/\\/g, '/').split('/');
  let current = '';

  for (const part of parts) {
    if (part === '') {
      current = '/';
      continue;
    }
    current = current === '' || current === '/' ? `${current}${part}` : `${current}/${part}`;

    const exists = await new Promise<boolean>((resolve) => {
      sftp.stat(current, (error) => resolve(!error));
    });
    if (!exists) {
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(current, (error) => (error ? reject(new TransferError(`创建远端目录失败: ${current}`, error)) : resolve()));
      });
    }
  }
};

/**
 * 断开继承并把 ACL 收敛为 owner 本人 / SYSTEM / Administrators。
 * SYSTEM/Administrators 用 SID 形式（*S-1-5-18 / *S-1-5-32-544），中文版 Windows 同样生效。
 */
export const runIcaclsLock = async (
  ssh: SshClient,
  winPath: string,
  owner: string,
  container: boolean,
): Promise<void> => {
  if (!OWNER_PATTERN.test(owner)) {
    throw new TransferError(`非法的 lock_owner: ${owner}`);
  }

  const flags = container ? '(OI)(CI)' : '';
  const command = `icacls "${winPath}" /inheritance:r /grant:r `
    + `"${owner}:${flags}F" "*S-1-5-18:${flags}F" "*S-1-5-32-544:${flags}F"`;

  const result = await execCommand(ssh, command, { timeoutMs: ICACLS_TIMEOUT_MS });
  if (result.code !== 0) {
    const detail = decodeRemote(result.stderr).trim() || decodeRemote(result.stdout).trim();
    throw new TransferError(`私有目录权限锁定失败(${winPath})：${detail || `exit ${result.code}`}`);
  }
};

export interface UploadOptions {
  readonly remoteDir?: string;
  readonly remoteName?: string;
  /** 传入用户名后，上传完成立刻收敛 NTFS ACL，防同机其他 RDP 用户读取 */
  readonly lockOwner?: string;
}

/** 上传本地文件到 Windows 云主机，返回 Windows 风格路径 */
export const uploadFileToWindows = async (
  localPath: string,
  { remoteDir, remoteName, lockOwner }: UploadOptions = {},
): Promise<string> => {
  const { windowsDataDir } = getSettings();

  try {
    await access(localPath);
  } catch {
    throw new TransferError(`待上传文件不存在: ${localPath}`);
  }
  if (lockOwner !== undefined && !OWNER_PATTERN.test(lockOwner)) {
    throw new TransferError(`非法的 lock_owner: ${lockOwner}`);
  }

  // basename 用 POSIX 语义取最后一段（路径可能来自 Windows 侧）
  const filename = remoteName ?? localPath.split(/[\\/]/).pop() ?? '';
  const targetDir = (remoteDir ?? windowsDataDir).replace(/\\/g, '/').replace(/\/$/, '');
  const remotePath = `${targetDir}/${filename}`;
  const winDir = targetDir.replace(/\//g, '\\');

  const ssh = await connectSsh();
  try {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      ssh.sftp((error, handle) => (error || !handle ? reject(new TransferError('SFTP 通道建立失败', error)) : resolve(handle)));
    });
    try {
      await ensureRemoteDir(sftp, targetDir);
      await new Promise<void>((resolve, reject) => {
        sftp.fastPut(localPath, remotePath, (error) => (error ? reject(new TransferError('SFTP 上传失败', error)) : resolve()));
      });
    } finally {
      sftp.end();
    }

    if (lockOwner) {
      await runIcaclsLock(ssh, winDir, lockOwner, true);
      await runIcaclsLock(ssh, `${winDir}\\${filename}`, lockOwner, false);
    }
  } finally {
    ssh.end();
  }

  return `${winDir}\\${filename}`;
};

/** 列出远端目录下的普通文件；目录不存在则返回空数组 */
export const listRemoteFiles = async (
  remoteDir: string,
): Promise<readonly { readonly filename: string; readonly size: number }[]> =>
  withSftp(async (sftp) => {
    const entries = await new Promise<readonly FileEntryWithStats[] | null>((resolve) => {
      sftp.readdir(remoteDir, (error, list) => resolve(error ? null : list));
    });
    if (entries === null) return [];

    return entries
      .filter((entry) => !entry.attrs.isDirectory())
      .map((entry) => ({ filename: entry.filename, size: Number(entry.attrs.size ?? 0) }));
  });

/** 从 Windows 云主机下载单个文件（父目录自动创建） */
export const downloadFileFromWindows = async (
  remoteDir: string,
  remoteName: string,
  localPath: string,
): Promise<string> => {
  const remotePath = `${remoteDir.replace(/\/$/, '')}/${remoteName}`;
  const parent = dirname(localPath);
  if (parent) await mkdir(parent, { recursive: true });

  await withSftp(async (sftp) => {
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(remotePath, localPath, (error) => (error ? reject(new TransferError('SFTP 下载失败', error)) : resolve()));
    });
  });

  return localPath;
};
