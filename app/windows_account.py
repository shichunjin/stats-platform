"""Windows 云主机账号同步：注册/改密时经 SSH 在 Windows 上创建同名本地账号。

同步内容（同一段幂等的远程 PowerShell 脚本，一次 SSH 调用完成）：
  1. 本地账号存在性（New-LocalUser / Set-LocalUser）
  2. 加入 Users、Remote Desktop Users 组（语言无关，按 SID 找组、按错误码判重）
  3. 用户私有目录 C:\\workspace\\{用户}、C:\\pending\\{用户}：
     断开继承并把 NTFS ACL 收敛为「仅本人 / SYSTEM / Administrators」，
     同时确保 workspace / pending 两个 SMB 共享存在且开启基于访问的枚举（ABE），
     使其他 RDP 用户看不到、也打不开他人的私有目录。
"""
import base64
import re

from .config import settings
from .transfer import connect_ssh

# Windows 本地账号规则：与平台用户名一致（同步前平台已校验），这里再做硬约束。
# 3~20 位，字母/数字/点/下划线/连字符；字母开头（避免纯数字或与设备名混淆）。
_WINDOWS_USERNAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{2,19}$")

# 内置组 SID（语言无关；不能依赖中文版"远程桌面用户"等本地化名称）
_SID_USERS = "S-1-5-32-545"
_SID_REMOTE_DESKTOP_USERS = "S-1-5-32-555"
_SID_SYSTEM = "*S-1-5-18"
_SID_ADMINISTRATORS = "*S-1-5-32-544"


class WindowsAccountError(Exception):
    """Windows 账号同步失败"""


def validate_windows_username(username: str) -> None:
    if not isinstance(username, str) or not _WINDOWS_USERNAME_RE.match(username):
        raise WindowsAccountError(
            "Windows 用户名需为 3~20 位、字母开头，仅允许字母、数字、点、下划线和连字符"
        )


def _ps_quote(value: str) -> str:
    """把任意字符串安全地放进 PowerShell 单引号字符串。"""
    return "'" + value.replace("'", "''") + "'"


def _win_path(value: str) -> str:
    """settings 里的 SFTP 风格正斜杠路径转成 Windows 反斜杠路径。"""
    return value.replace("/", "\\").rstrip("\\").replace("'", "''")


def _decode_remote(data: bytes) -> str:
    """中文版 Windows 的错误输出通常是 GBK，做一次兜底解码。"""
    for enc in ("utf-8", "gbk", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return repr(data)


# ---- 账号部分 ----
_PS_SCRIPT = r"""
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
    New-LocalUser -Name $username -Password $secure -FullName $username `
        -Description 'stats-platform' -AccountNeverExpires -PasswordNeverExpires `
        -ErrorAction Stop | Out-Null
    Write-Output 'STATS_WINDOWS_USER_CREATED'
} else {
    Set-LocalUser -Name $username -Password $secure -ErrorAction Stop
    Write-Output 'STATS_WINDOWS_USER_UPDATED'
}

Ensure-GroupMember '{sid_users}' $username
Ensure-GroupMember '{sid_rdp}' $username
""".lstrip()


# ---- 私有工作区部分（workspace = W: 盘，pending = 结果暂存）----
# 与建号脚本分开定义，便于老账号在不知道密码的情况下单独补偿。
_WORKSPACE_PS = r"""
$ErrorActionPreference = 'Stop'
$username = {username}
$workspaceRoot = {workspace_root}
$pendingRoot   = {pending_root}
$deepReset     = {deep_reset}

function Ensure-Share($name, $path) {
    if (-not (Get-SmbShare -Name $name -ErrorAction SilentlyContinue)) {
        New-SmbShare -Name $name -Path $path `
            -ChangeAccess 'Remote Desktop Users' -FullAccess 'Administrators' | Out-Null
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
        icacls (Join-Path $d '*') /T /C /inheritance:r /grant $userGrant `
            '{sid_system}:(OI)(CI)F' '{sid_admins}:(OI)(CI)F' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw ('icacls deep reset failed: ' + $d) }
    }
}
Write-Output 'STATS_WINDOWS_WORKSPACE_READY'
""".lstrip()


def _fill(template: str, **values: str) -> str:
    """按 {name} 占位符做纯文本替换。

    不能用 str.format：PowerShell 脚本里大量 `{ }` 脚本块会被误判为格式字段。
    """
    for key, value in values.items():
        template = template.replace("{" + key + "}", value)
    return template


def _build_account_script(username: str, password: str) -> str:
    workspace = _build_workspace_script(username, deep_reset=False)
    return (
        _fill(
            _PS_SCRIPT,
            username=_ps_quote(username),
            password=_ps_quote(password),
            sid_users=_SID_USERS,
            sid_rdp=_SID_REMOTE_DESKTOP_USERS,
        )
        + "\n"
        + workspace
    )


def _build_workspace_script(username: str, deep_reset: bool) -> str:
    return _fill(
        _WORKSPACE_PS,
        username=_ps_quote(username),
        workspace_root=_ps_quote(_win_path(settings.windows_workspace_dir)),
        pending_root=_ps_quote(_win_path(settings.windows_pending_dir)),
        deep_reset="$true" if deep_reset else "$false",
        sid_system=_SID_SYSTEM,
        sid_admins=_SID_ADMINISTRATORS,
    )


def _run_remote_ps(inner_script: str, action: str, username: str) -> None:
    """在 Windows 上经 SSH 执行一段 PowerShell。

    传输方式：powershell -Command - 从 stdin 读命令（绕开命令行长度限制与代码页问题）；
    实际脚本以 UTF-16LE Base64 载荷嵌在 ASCII 包装器里（中文系统 GBK 代码页安全）。
    """
    encoded = base64.b64encode(inner_script.encode("utf-16-le")).decode("ascii")
    wrapper = (
        "$__s = [Text.Encoding]::Unicode.GetString("
        f"[Convert]::FromBase64String('{encoded}')); "
        "Invoke-Expression $__s"
    )
    command = "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -"

    try:
        ssh = connect_ssh()
    except Exception as e:
        raise WindowsAccountError(f"无法连接 Windows 云主机: {e}") from e

    try:
        stdin, stdout, stderr = ssh.exec_command(command, timeout=25)
        try:
            stdin.write(wrapper)
            stdin.flush()
        finally:
            stdin.channel.shutdown_write()

        out = _decode_remote(stdout.read())
        err = _decode_remote(stderr.read())
        code = stdin.channel.recv_exit_status()
    finally:
        ssh.close()

    if code != 0:
        detail = err.strip() or out.strip() or f"exit code {code}"
        raise WindowsAccountError(
            f"Windows 账号同步失败（{action} {username}）：{detail[:500]}"
        )


def windows_sync_enabled() -> bool:
    return bool(settings.windows_account_sync)


def sync_windows_user(username: str, password: str) -> bool:
    """注册/改密后同步：创建或更新 Windows 本地账号，并保障私有工作区。

    返回 True 表示执行了同步；False 表示功能关闭跳过。
    远端任何失败都抛 WindowsAccountError，由调用方决定回滚。
    """
    if not settings.windows_account_sync:
        return False
    validate_windows_username(username)
    if any(ord(c) < 0x20 for c in password):
        raise WindowsAccountError("密码中不允许包含控制字符")

    script = _build_account_script(username, password)
    _run_remote_ps(script, "同步账号", username)
    return True


def provision_user_workspace(username: str, deep_reset: bool = False) -> bool:
    """只为用户开通/修复私有工作区目录与 ACL（不需要密码）。

    供老账号补偿：deep_reset=True 时会递归重置目录内历史文件的权限。
    返回 True 表示执行了同步；False 表示功能关闭跳过。
    """
    if not settings.windows_account_sync:
        return False
    validate_windows_username(username)

    script = _build_workspace_script(username, deep_reset=deep_reset)
    _run_remote_ps(script, "保障工作区", username)
    return True
