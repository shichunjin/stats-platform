"""Windows 云主机本地账号同步

平台注册 / 修改密码时，经 OpenSSH（与 SFTP 同一套 Administrator 免密私钥）
在 Windows 云主机上创建或更新同名本地账号，使三端账号体系保持一致：

    平台账号 == Guacamole 账号 == Windows 本地账号（同名同密码）

Guacamole 专属 RDP 连接开启了 RDP 自动登录，因此 Windows 账号存在且密码
一致时，用户浏览器一键即可进入属于自己的云桌面，由 NTFS ACL / 登录脚本
按用户名落实数据隔离。

安全要点：
- 密码通过 SSH 加密通道写入 PowerShell 的 **stdin**，不出现在远端进程
  命令行、计划任务或命令历史中；
- 用户名做白名单校验（Windows 账号命名规则），杜绝命令注入；
- PowerShell 单引号字符串中的单引号按 PS 规则转义为两个单引号。
"""
import base64
import logging
import re

from app.config import settings
from app.transfer import connect_ssh

logger = logging.getLogger("stats-platform")

# Windows 本地账号命名规则：
# - 长度 1-20（这里平台侧限制 3-20）
# - 只允许字母数字与 . _ -
# - 不得包含 " / \ [ ] : ; | = , + * ? < > @ 及空格（白名单天然排除）
WINDOWS_USERNAME_RE = re.compile(r"^[A-Za-z0-9._-]{3,20}$")

# 远程执行的 PowerShell 脚本。{username}/{password} 为单引号安全转义后的占位。
# 关键点：
# - 组名通过内置 SID 翻译，兼容中文/英文 Windows（远程桌面用户 S-1-5-32-555、
#   普通用户 Users S-1-5-32-545），不依赖本地化组名字面量；
# - 新用户必须显式加入 Users 组（New-LocalUser 不会自动加入）；
# - 全部操作幂等，重复执行安全（重试友好）。
_PS_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$username = '{username}'
$password = '{password}'
$secure = ConvertTo-SecureString -String $password -AsPlainText -Force

$existing = Get-LocalUser -Name $username -ErrorAction SilentlyContinue
if ($existing) {
    Set-LocalUser -Name $username -Password $secure
    Enable-LocalUser -Name $username
    $action = 'updated'
} else {
    New-LocalUser -Name $username -Password $secure -FullName $username `
        -Description 'Stats Platform user' -PasswordNeverExpires -AccountNeverExpires | Out-Null
    $action = 'created'
}

# 加入 Users 组（S-1-5-32-545）
$usersGroup = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-545')).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
try {
    Add-LocalGroupMember -Group $usersGroup -Member $username -ErrorAction Stop
} catch {
    if ($_.Exception.Message -notmatch 'already a member') { throw }
}

# 加入 Remote Desktop Users 组（S-1-5-32-555）
$rdpGroup = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-555')).Translate([System.Security.Principal.NTAccount]).Value.Split('\')[-1]
try {
    Add-LocalGroupMember -Group $rdpGroup -Member $username -ErrorAction Stop
} catch {
    if ($_.Exception.Message -notmatch 'already a member') { throw }
}

Write-Output ("STATS_WINDOWS_USER_" + $action.ToUpper())
""".strip()


class WindowsAccountError(RuntimeError):
    """Windows 账号同步失败（连接/命名/密码策略/远端执行错误）"""


def windows_sync_enabled() -> bool:
    """是否启用 Windows 账号同步"""
    return settings.windows_account_sync


def validate_windows_username(username: str) -> None:
    """校验用户名是否可作为 Windows 本地账号名，不合法抛 WindowsAccountError"""
    if not WINDOWS_USERNAME_RE.fullmatch(username or ""):
        raise WindowsAccountError(
            f"用户名 '{username}' 不符合 Windows 账号规则："
            "需为 3-20 位字母、数字或 . _ -，且不能含空格与特殊字符"
        )


def _ps_quote(value: str) -> str:
    """转义为 PowerShell 单引号字符串安全内容（' -> ''），拒绝控制字符"""
    if any(ord(ch) < 0x20 for ch in value):
        raise WindowsAccountError("密码包含非法控制字符")
    return value.replace("'", "''")


def _build_script(username: str, password: str) -> str:
    """生成实际执行的 PowerShell 脚本（UTF-16LE Base64 解码后执行的载荷）"""
    validate_windows_username(username)
    # 用 replace 而不是 str.format：脚本里的 PowerShell 花括号不能被格式化引擎解释
    return _PS_SCRIPT.replace("'{username}'", f"'{username}'").replace(
        "'{password}'", f"'{_ps_quote(password)}'"
    )


def _build_stdin_payload(inner_script: str) -> str:
    """把载荷包装成纯 ASCII 的 stdin 脚本：Base64(UTF-16LE 脚本) 解码后执行。

    这样可以绕开中文 Windows 下 stdin 默认 GBK 代码页导致的非 ASCII 密码乱码，
    密码也不会出现在远端进程命令行中。
    """
    encoded = base64.b64encode(inner_script.encode("utf-16-le")).decode("ascii")
    return (
        "$ErrorActionPreference = 'Stop'\n"
        "$__stats_code = [System.Text.Encoding]::Unicode.GetString("
        f"[System.Convert]::FromBase64String('{encoded}'))\n"
        "Invoke-Expression $__stats_code\n"
    )


def sync_windows_user(username: str, password: str) -> bool:
    """在 Windows 云主机上创建账号或重置为指定密码，并保证 RDP 登录权限。

    - 启用同步时执行；未启用直接返回 False；
    - 幂等：账号已存在则改密+启用，不存在则新建并加入 Users / Remote Desktop Users；
    - 任何失败抛 :class:`WindowsAccountError`，调用方应整体失败（三端一致）。
      所有操作均可安全重试。
    """
    if not windows_sync_enabled():
        return False

    inner_script = _build_script(username, password)
    stdin_payload = _build_stdin_payload(inner_script)

    try:
        ssh = connect_ssh()
    except Exception as exc:
        raise WindowsAccountError(f"无法连接 Windows 云主机执行账号同步: {exc}") from exc

    try:
        # -Command - 让 PowerShell 从 stdin 读取脚本，密码不进入进程命令行
        stdin, stdout, stderr = ssh.exec_command(
            "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -",
            timeout=60,
        )
        stdin.write(stdin_payload)
        stdin.flush()
        stdin.channel.shutdown_write()

        exit_code = stdout.channel.recv_exit_status()
        out = stdout.read().decode("utf-8", "replace").strip()
        err = stderr.read().decode("utf-8", "replace").strip()

        if exit_code != 0:
            # Windows 常见失败：密码不满足长度/复杂度/历史策略
            detail = err or out or f"exit code {exit_code}"
            logger.warning("Windows 账号同步失败 user=%s: %s", username, detail)
            raise WindowsAccountError(f"Windows 账号同步失败: {detail}")

        logger.info("Windows 账号同步成功 user=%s result=%s", username, out)
        return True
    except WindowsAccountError:
        raise
    except Exception as exc:  # 网络/SSH 层错误
        logger.warning("Windows 账号同步异常 user=%s: %s", username, exc)
        raise WindowsAccountError(f"无法连接 Windows 云主机执行账号同步: {exc}") from exc
    finally:
        ssh.close()
