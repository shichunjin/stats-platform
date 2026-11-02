/**
 * Windows 云主机账号同步 —— app/windows_account.py
 *
 * 经 SSH 在 Windows 上执行一段幂等的远程 PowerShell：
 *  1. 创建/更新同名本地账号，加入 Users 与 Remote Desktop Users 组（按 SID，语言无关）
 *  2. 创建用户私有目录 workspace/pending，断开继承并收敛 NTFS ACL
 *  3. 确保 workspace / pending 两个 SMB 共享存在并开启 ABE（基于访问的枚举）
 *
 * 与 Python 版完全一致的关键约束：
 *  - 脚本以 UTF-16LE Base64 载荷嵌在 ASCII 包装器里从 stdin 传入
 *    （绕开命令行长度限制 + 中文系统 GBK 代码页问题）
 *  - 占位符用纯文本替换，不能用模板字符串插值（脚本里有大量 { } 脚本块）
 */
import { getSettings } from '../config/env.js';
import { TransferError, connectSsh, decodeRemote, execCommand } from './transfer.js';

/** 3~20 位、字母开头，仅字母/数字/点/下划线/连字符 */
const WINDOWS_USERNAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{2,19}$/;

/** 内置组 SID（语言无关；不能依赖中文版"远程桌面用户"等本地化名称） */
const SID_USERS = 'S-1-5-32-545';
const SID_REMOTE_DESKTOP_USERS = 'S-1-5-32-555';
const SID_SYSTEM = '*S-1-5-18';
const SID_ADMINISTRATORS = '*S-1-5-32-544';

const REMOTE_EXEC_TIMEOUT_MS = 25_000;

export class WindowsAccountError extends Error {
  constructor(message: string, override readonly cause?: unknown) {
    super(message);
    this.name = 'WindowsAccountError';
  }
}

export const validateWindowsUsername = (username: string): void => {
  if (!WINDOWS_USERNAME_PATTERN.test(username)) {
    throw new WindowsAccountError(
      'Windows 用户名需为 3~20 位、字母开头，仅允许字母、数字、点、下划线和连字符',
    );
  }
};

/** 把任意字符串安全地放进 PowerShell 单引号字符串 */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** settings 里的 SFTP 风格正斜杠路径 → Windows 反斜杠路径 */
const toWinPath = (value: string): string =>
  value.replace(/\//g, '\\').replace(/\\+$/, '').replace(/'/g, "''");

/**
 * 按 {name} 占位符做纯文本替换。
 * 刻意不用模板字符串：PowerShell 脚本里的 { } 脚本块会被误判为插值字段。
 */
const fill = (template: string, values: Readonly<Record<string, string>>): string => {
  let result = template;
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
};

/* ---------------------------------------------------------------- *
 * 远程脚本（与 Python 版逐字一致）
 * ---------------------------------------------------------------- */

const PS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'

$username = {username}
$password = {password}

function Ensure-GroupMember($groupSid, $accountName) {
    try {
        $group = New-Object System.Security.Principal.SecurityIdentifier($groupSid)
        $groupName = $group.Translate([System.Security.Principal.NTAccount]).Value
        $domain, $name = $groupName -split '\\', 2
        if ($domain) { $groupName = $name }
        $members = Get-LocalGroupMember -SID $groupSid -ErrorAction Stop
        $exists = $false
        foreach ($m in $members) {
            $short = ($m.Name -split '\\', 2)[-1]
            if ($short -eq $accountName) { $exists = $true; break }
        }
        if (-not $exists) {
            Add-LocalGroupMember -SID $groupSid -Member $accountName -ErrorAction Stop
        }
    }
    catch {
        $fqe = $_.FullyQualifiedErrorId
        if ($fqe -like 'MemberExists*') {
            # 已在组中（并发预检与添加之间被其他调用抢先），幂等视为成功
        } else {
            throw
        }
    }
}

$secure = ConvertTo-SecureString $password -AsPlainText -Force
$existing = Get-LocalUser -Name $username -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    New-LocalUser -Name $username -Password $secure -FullName $username -Description 'stats-platform' -AccountNeverExpires -PasswordNeverExpires:{password_never_expires} -ErrorAction Stop | Out-Null
    Write-Output 'STATS_WINDOWS_USER_CREATED'
} else {
    Set-LocalUser -Name $username -Password $secure -ErrorAction Stop
    # 安全修复 C6：既有账号同步密码过期策略（默认遵循 Windows 密码过期，不再强制永不过期）
    Set-LocalUser -Name $username -PasswordNeverExpires:{password_never_expires} -ErrorAction Stop
    Write-Output 'STATS_WINDOWS_USER_UPDATED'
}

Ensure-GroupMember '{sid_users}' $username
Ensure-GroupMember '{sid_rdp}' $username
`.trimStart();

const WORKSPACE_PS = String.raw`
$ErrorActionPreference = 'Stop'
$username = {username}
$workspaceRoot = {workspace_root}
$pendingRoot   = {pending_root}
$deepReset     = {deep_reset}

function Ensure-Share($name, $path) {
    if (-not (Get-SmbShare -Name $name -ErrorAction SilentlyContinue)) {
        New-SmbShare -Name $name -Path $path -ChangeAccess 'Remote Desktop Users' -FullAccess 'Administrators' | Out-Null
    }
    # 基于访问的枚举：共享根下只显示当前用户有 NTFS 权限的目录
    Set-SmbShare -Name $name -FolderEnumerationMode AccessBased -Force
}

foreach ($root in @($workspaceRoot, $pendingRoot)) {
    if (-not (Test-Path -LiteralPath $root)) {
        New-Item -ItemType Directory -Path $root -Force | Out-Null
    }
}
Ensure-Share 'workspace' $workspaceRoot
Ensure-Share 'pending'   $pendingRoot

$userGrant = $username + ':(OI)(CI)F'
foreach ($d in @((Join-Path $workspaceRoot $username), (Join-Path $pendingRoot $username))) {
    if (-not (Test-Path -LiteralPath $d)) {
        New-Item -ItemType Directory -Path $d -Force | Out-Null
    }
    # 断开继承、删除继承来的 ACE，只保留本人 / SYSTEM / Administrators
    icacls $d /inheritance:r /grant $userGrant '{sid_system}:(OI)(CI)F' '{sid_admins}:(OI)(CI)F' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('icacls failed: ' + $d) }
    # 补偿老目录时，把已存在的历史文件一并重新锁定（新注册用户目录为空，跳过）
    if ($deepReset -and (Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue)) {
        icacls (Join-Path $d '*') /T /C /inheritance:r /grant $userGrant '{sid_system}:(OI)(CI)F' '{sid_admins}:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('icacls deep reset failed: ' + $d) }
    }
}
Write-Output 'STATS_WINDOWS_WORKSPACE_READY'
`.trimStart();

/**
 * 只建账号与加组（PS_SCRIPT 部分）。
 *
 * 云桌面改造后必须区分两种目标（方案 3.4 / 附录 D）：
 *  - **文件服务器**：账号 + 工作区（SMB 共享、NTFS ACL）→ 用 `buildAccountScript`
 *  - **用户 VM**：**只建账号**，绝不跑 workspace 脚本 —— 在 VM 上执行会试图
 *    把 VM 变成文件服务器（建共享 + 改 ACL），数据落点就散了。
 */
export const buildAccountOnlyScript = (username: string, password: string): string => {
  const { windowsPasswordNeverExpires } = getSettings();
  return fill(PS_SCRIPT, {
    username: psQuote(username),
    password: psQuote(password),
    sid_users: SID_USERS,
    sid_rdp: SID_REMOTE_DESKTOP_USERS,
    password_never_expires: windowsPasswordNeverExpires ? '$true' : '$false',
  });
};

export const buildAccountScript = (username: string, password: string): string => [
  buildAccountOnlyScript(username, password),
  buildWorkspaceScript(username, false),
].join('\n');

export const buildWorkspaceScript = (username: string, deepReset: boolean): string => {
  const { windowsWorkspaceDir, windowsPendingDir } = getSettings();
  return fill(WORKSPACE_PS, {
    username: psQuote(username),
    workspace_root: psQuote(toWinPath(windowsWorkspaceDir)),
    pending_root: psQuote(toWinPath(windowsPendingDir)),
    deep_reset: deepReset ? '$true' : '$false',
    sid_system: SID_SYSTEM,
    sid_admins: SID_ADMINISTRATORS,
  });
};

/**
 * 在 Windows 上经 SSH 执行 PowerShell：
 * 脚本以 UTF-16LE Base64 载荷嵌在 ASCII 包装器里，`powershell -Command -` 从 stdin 读。
 */
const runRemotePs = async (
  script: string,
  action: string,
  username: string,
  target?: string,
): Promise<void> => {
  // Node 的 Buffer 直接支持 utf16le，无需手工换算
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const wrapper = `$__s = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); `
    + 'Invoke-Expression $__s';
  const command = 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -';

  let ssh;
  try {
    ssh = await connectSsh(target);
  } catch (error) {
    throw new WindowsAccountError('无法连接 Windows 云主机', error);
  }

  try {
    const { code, stdout, stderr } = await execCommand(ssh, command, {
      stdin: wrapper,
      timeoutMs: REMOTE_EXEC_TIMEOUT_MS,
    });

    if (code !== 0) {
      const detail = decodeRemote(stderr).trim() || decodeRemote(stdout).trim() || `exit code ${code}`;
      throw new WindowsAccountError(`Windows 账号同步失败（${action} ${username}）：${detail.slice(0, 500)}`);
    }
  } catch (error) {
    if (error instanceof WindowsAccountError) throw error;
    if (error instanceof TransferError) throw new WindowsAccountError(String(error.message), error);
    throw error;
  } finally {
    ssh.end();
  }
};

/** C5：未配置 sftp_host 时同步视为关闭，避免向空地址发起 SSH 连接 */
export const windowsSyncEnabled = (): boolean => {
  const { windowsAccountSync, sftpHost } = getSettings();
  return Boolean(windowsAccountSync && sftpHost);
};

export interface SyncWindowsOptions {
  /** 目标主机：null/省略 = 中心文件服务器（现状）；传 VM IP = 同步用户 VM */
  readonly host?: string;
  /**
   * 是否同时保障工作区（SMB 共享 + NTFS ACL）。
   * 默认 true（现状，文件服务器）；**同步 VM 时必须传 false**（见 buildAccountOnlyScript 注释）。
   */
  readonly workspace?: boolean;
}

/** 注册/改密后同步：创建或更新 Windows 本地账号，并（可选）保障私有工作区 */
export const syncWindowsUser = async (
  username: string,
  password: string,
  options: SyncWindowsOptions = {},
): Promise<boolean> => {
  if (!getSettings().windowsAccountSync) return false;

  validateWindowsUsername(username);
  // eslint-disable-next-line no-control-regex
  if ([...password].some((char) => char.charCodeAt(0) < 0x20)) {
    throw new WindowsAccountError('密码中不允许包含控制字符');
  }

  const workspace = options.workspace ?? true;
  const script = workspace
    ? buildAccountScript(username, password)
    : buildAccountOnlyScript(username, password);
  await runRemotePs(script, '同步账号', username, options.host);
  return true;
};

/** 只为用户开通/修复私有工作区目录与 ACL（不需要密码） */
export const provisionUserWorkspace = async (
  username: string,
  deepReset = false,
): Promise<boolean> => {
  if (!getSettings().windowsAccountSync) return false;

  validateWindowsUsername(username);
  await runRemotePs(buildWorkspaceScript(username, deepReset), '保障工作区', username);
  return true;
};
