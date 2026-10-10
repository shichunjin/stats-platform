"""SFTP 文件传输：把 Linux 后端生成的文件推送到 Windows 云主机

使用 paramiko + 密钥免密认证。Windows 端需先启用 OpenSSH Server
（见 powershell/setup-sftp-datadrive.ps1），并把 Linux 端公钥加入
C:\\ProgramData\\ssh\\administrators_authorized_keys。
"""
import os

import paramiko

from app.config import settings


def _connect_sftp() -> tuple[paramiko.SFTPClient, paramiko.SSHClient]:
    """建立 SFTP 连接，返回 (sftp, ssh_client)。调用方负责关闭。"""
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


def upload_file_to_windows(local_path: str) -> str:
    """把本地文件 SFTP 上传到 Windows 云主机配置的目录下。

    - 文件名沿用本地文件名
    - 返回 Windows 风格路径（如 C:\\StatsData\\testData.xlsx）
    """
    if not os.path.exists(local_path):
        raise FileNotFoundError(f"待上传文件不存在: {local_path}")

    filename = os.path.basename(local_path)
    remote_dir = settings.windows_data_dir.replace("\\", "/").rstrip("/")
    remote_path = f"{remote_dir}/{filename}"

    sftp, ssh = _connect_sftp()
    try:
        _ensure_remote_dir(sftp, remote_dir)
        sftp.put(local_path, remote_path)
    finally:
        sftp.close()
        ssh.close()

    # 返回展示用的 Windows 本地路径
    win_dir = settings.windows_data_dir.replace("/", "\\").rstrip("\\")
    return f"{win_dir}\\{filename}"
