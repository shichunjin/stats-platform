"""SFTP 文件传输：把 Linux 后端生成的文件推送到 Windows 云主机

使用 paramiko + 密钥免密认证。Windows 端需先启用 OpenSSH Server
（见 powershell/setup-sftp-datadrive.ps1），并把 Linux 端公钥加入
C:\\ProgramData\\ssh\\administrators_authorized_keys。
"""
import os
import re

import paramiko

from app.config import settings

# 与 Windows 本地账号规则保持一致；lock_owner 会进入远程命令，必须白名单校验
_OWNER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9._-]{2,19}$")


def connect_ssh() -> paramiko.SSHClient:
    """建立到 Windows 云主机的 SSH 连接（密钥免密）。调用方负责 close。"""
    key_path = os.path.expanduser(settings.sftp_key_path)
    if not os.path.exists(key_path):
        raise FileNotFoundError(f"SFTP 私钥不存在: {key_path}")

    # 根据私钥类型加载（Ed25519 / RSA / ECDSA）
    key_classes = (
        paramiko.Ed25519Key,
        paramiko.RSAKey,
        paramiko.ECDSAKey,
    )
    pkey = None
    last_err = None
    for key_cls in key_classes:
        try:
            pkey = key_cls.from_private_key_file(
                key_path,
                password=settings.sftp_passphrase or None,
            )
            break
        except paramiko.SSHException as e:
            last_err = e
    if pkey is None:
        raise ValueError(f"无法加载 SFTP 私钥 {key_path}: {last_err}")

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(
        hostname=settings.sftp_host,
        port=settings.sftp_port,
        username=settings.sftp_username,
        pkey=pkey,
        timeout=15,
        allow_agent=False,
        look_for_keys=False,
    )
    return ssh


def _connect_sftp() -> tuple[paramiko.SFTPClient, paramiko.SSHClient]:
    """建立 SFTP 连接，返回 (sftp, ssh_client)。调用方负责关闭。"""
    ssh = connect_ssh()
    return ssh.open_sftp(), ssh


def _ensure_remote_dir(sftp: paramiko.SFTPClient, remote_dir: str):
    """递归创建远端目录（类似 mkdir -p），已存在则跳过。"""
    # 统一为正斜杠，Windows OpenSSH 同时接受 C:/StatsData
    parts = remote_dir.replace("\\", "/").split("/")
    current = ""
    for part in parts:
        if part == "":
            # 开头的 "/"（Unix 绝对路径）产生的空段
            current = "/"
            continue
        if current == "":
            current = part
        elif current == "/":
            current = "/" + part
        else:
            current = f"{current}/{part}"
        try:
            sftp.stat(current)
        except FileNotFoundError:
            sftp.mkdir(current)


def _run_icacls_lock(ssh: paramiko.SSHClient, win_path: str, owner: str,
                     container: bool) -> None:
    """断开继承并把 ACL 收敛为 owner 本人 / SYSTEM / Administrators。

    container=True 时加 (OI)(CI) 继承标志（用于目录）；否则锁单个文件。
    SYSTEM/Administrators 用 SID 形式（*S-1-5-18 / *S-1-5-32-544），
    在中文版 Windows 上同样生效。
    """
    flags = "(OI)(CI)" if container else ""
    command = (
        f'icacls "{win_path}" /inheritance:r /grant:r '
        f'"{owner}:{flags}F" '
        f'"*S-1-5-18:{flags}F" '
        f'"*S-1-5-32-544:{flags}F"'
    )
    _stdin, stdout, stderr = ssh.exec_command(command, timeout=20)
    code = stdout.channel.recv_exit_status()
    if code != 0:
        err = (stderr.read().decode("gbk", errors="replace")
               or stdout.read().decode("gbk", errors="replace")).strip()
        raise RuntimeError(f"私有目录权限锁定失败({win_path})：{err or f'exit {code}'}")


def upload_file_to_windows(
    local_path: str,
    remote_dir: str | None = None,
    remote_name: str | None = None,
    lock_owner: str | None = None,
) -> str:
    """把本地文件 SFTP 上传到 Windows 云主机。

    - remote_dir：远端目录（不传则使用配置中的公共数据目录），支持子目录，
      不存在会自动递归创建（可用于按用户隔离的目录）
    - remote_name：远端文件名（不传则沿用本地文件名）
    - lock_owner：传入用户名后，上传完成会立即把目标目录与文件的 NTFS ACL
      收敛为仅该用户 / SYSTEM / Administrators（防同机其他 RDP 用户读取）
    - 返回 Windows 风格路径（如 C:\\workspace\\user1\\testData.xlsx）
    """
    if not os.path.exists(local_path):
        raise FileNotFoundError(f"待上传文件不存在: {local_path}")
    if lock_owner is not None and not _OWNER_RE.match(lock_owner):
        raise ValueError(f"非法的 lock_owner: {lock_owner!r}")

    filename = remote_name or os.path.basename(local_path)
    target_dir = (remote_dir or settings.windows_data_dir).replace("\\", "/").rstrip("/")
    remote_path = f"{target_dir}/{filename}"

    sftp, ssh = _connect_sftp()
    try:
        _ensure_remote_dir(sftp, target_dir)
        sftp.put(local_path, remote_path)
        if lock_owner:
            win_dir = target_dir.replace("/", "\\")
            _run_icacls_lock(ssh, win_dir, lock_owner, container=True)
            _run_icacls_lock(ssh, f"{win_dir}\\{filename}", lock_owner,
                             container=False)
    finally:
        sftp.close()
        ssh.close()

    # 返回展示用的 Windows 本地路径
    win_dir = target_dir.replace("/", "\\")
    return f"{win_dir}\\{filename}"
