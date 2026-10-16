"""Guacamole (guacamole-auth-jdbc) 用户与专属连接同步

平台注册/修改密码时，在 Guacamole 的 JDBC 认证库中：

1. 创建或更新同名用户账号，密码与平台始终一致；
2. 为该用户创建一条**专属 RDP 连接**（一人一连接），连接参数中的
   RDP 用户名强制写为该平台用户名 —— 用户经 Guacamole 连上 Windows 时
   身份确定，配合 Windows 端 NTFS ACL / 登录脚本实现按用户的绝对隔离；
3. 仅授予该用户对自己专属连接的 READ 权限，用户之间互不可见、不可用。

密码算法遵循 guacamole-auth-jdbc 标准：
    password_salt = 32 字节随机盐
    password_hash = SHA256( 明文密码(UTF-8) + salt 的小写 hex 字符串(UTF-8) )

连接名约定为 ``{GUAC_CONNECTION_PREFIX}{用户名}``（默认 ``windows-用户名``）。

未配置 settings.guac_db_url 时所有函数静默跳过（本地开发/测试环境）。
"""
import hashlib
import secrets
from datetime import datetime
from typing import Optional

from sqlalchemy import create_engine, text

from app.config import settings


def guac_sync_enabled() -> bool:
    """是否启用了 Guacamole 同步"""
    return bool(settings.guac_db_url)


def _hash_password(password: str, salt: bytes) -> bytes:
    """guacamole-auth-jdbc 标准密码哈希"""
    return hashlib.sha256(
        password.encode("utf-8") + salt.hex().encode("utf-8")
    ).digest()


def _connection_name(username: str) -> str:
    """用户专属 RDP 连接的名称"""
    return f"{settings.guac_connection_prefix}{username}"


def _build_rdp_parameters(username: str, password: Optional[str]) -> dict:
    """构建专属 RDP 连接参数（参数名遵循 Guacamole RDP 协议标准）。

    - 强制写入 RDP 用户名：按用户名映射 Windows 身份，用户无法手工改成他人；
    - 自动登录开启时写入明文密码，实现浏览器一键直连（要求 Windows 账号
      与平台账号同名同密码）；
    - 虚拟盘 / 录像目录均按用户名隔离子目录。
    """
    params = {
        "hostname": settings.rds_host,
        "port": str(settings.rds_port),
        # 客户端窗口大小随浏览器自适应
        "resize-method": "display-update",
    }

    if settings.guac_rdp_auto_login:
        params["username"] = username
        if password:
            # 注意：guacamole-auth-jdbc 以明文存储连接密码（其已知设计特性），
            # 因此必须保证 guacamole 库不暴露到公网（本项目仅映射 127.0.0.1）。
            params["password"] = password
        if settings.guac_rdp_domain:
            params["domain"] = settings.guac_rdp_domain

    if settings.guac_rdp_security:
        params["security"] = settings.guac_rdp_security
    if settings.guac_rdp_ignore_cert:
        params["ignore-cert"] = "true"

    # RDP 虚拟驱动器（浏览器与远程会话之间传文件），按用户隔离 guacd 落地目录
    if settings.guac_drive_root:
        root = settings.guac_drive_root.rstrip("/")
        params.update({
            "enable-drive": "true",
            "create-drive-path": "true",
            "drive-path": f"{root}/{username}",
        })

    # 会话录像（审计），按用户隔离
    if settings.guac_recording_root:
        root = settings.guac_recording_root.rstrip("/")
        params.update({
            "enable-recording": "true",
            "create-recording-path": "true",
            "recording-path": f"{root}/{username}",
            "include-recording-name": "true",
            "recording-name": "recording",
        })

    return params


def _ensure_entity(conn, username: str) -> int:
    """返回用户实体 ID，不存在则创建"""
    row = conn.execute(
        text("SELECT entity_id FROM guacamole_entity "
             "WHERE name = :name AND type = 'USER'"),
        {"name": username},
    ).first()
    if row:
        return row[0]
    conn.execute(
        text("INSERT INTO guacamole_entity (name, type) VALUES (:name, 'USER')"),
        {"name": username},
    )
    return conn.execute(
        text("SELECT entity_id FROM guacamole_entity "
             "WHERE name = :name AND type = 'USER'"),
        {"name": username},
    ).scalar_one()


def _set_user_password(conn, entity_id: int, password: str) -> None:
    """写入/更新 guacamole 用户密码行"""
    salt = secrets.token_bytes(32)
    pwd_hash = _hash_password(password, salt)
    now = datetime.utcnow()
    result = conn.execute(
        text("UPDATE guacamole_user SET password_hash = :h, password_salt = :s, "
             "password_date = :d, disabled = 0, expired = 0 WHERE entity_id = :eid"),
        {"h": pwd_hash, "s": salt, "d": now, "eid": entity_id},
    )
    if result.rowcount == 0:
        conn.execute(
            text("INSERT INTO guacamole_user "
                 "(entity_id, password_hash, password_salt, password_date, disabled, expired) "
                 "VALUES (:eid, :h, :s, :d, 0, 0)"),
            {"eid": entity_id, "h": pwd_hash, "s": salt, "d": now},
        )


def _ensure_connection(conn, username: str, password: Optional[str]) -> int:
    """创建或更新用户专属 RDP 连接，返回 connection_id。

    连接参数每次全量重写（先删后插），保证配置变更（如主机地址、RDP 密码
    更新）能完全同步，不残留历史参数。
    """
    name = _connection_name(username)
    row = conn.execute(
        text("SELECT connection_id FROM guacamole_connection WHERE connection_name = :n"),
        {"n": name},
    ).first()

    if row:
        connection_id = row[0]
    else:
        conn.execute(
            text("INSERT INTO guacamole_connection (connection_name, protocol, failover_only) "
                 "VALUES (:n, 'rdp', FALSE)"),
            {"n": name},
        )
        connection_id = conn.execute(
            text("SELECT connection_id FROM guacamole_connection WHERE connection_name = :n"),
            {"n": name},
        ).scalar_one()

    # 全量重写连接参数
    conn.execute(
        text("DELETE FROM guacamole_connection_parameter WHERE connection_id = :cid"),
        {"cid": connection_id},
    )
    params = _build_rdp_parameters(username, password)
    for key, value in params.items():
        conn.execute(
            text("INSERT INTO guacamole_connection_parameter "
                 "(connection_id, parameter_name, parameter_value) "
                 "VALUES (:cid, :k, :v)"),
            {"cid": connection_id, "k": key, "v": str(value)},
        )

    return connection_id


def _grant_read(conn, entity_id: int, connection_id: int) -> None:
    """授予用户对连接的 READ 权限（幂等）。只授自己的连接，形成用户间隔离。"""
    exists = conn.execute(
        text("SELECT 1 FROM guacamole_connection_permission "
             "WHERE entity_id = :eid AND connection_id = :cid AND permission = 'READ'"),
        {"eid": entity_id, "cid": connection_id},
    ).first()
    if not exists:
        conn.execute(
            text("INSERT INTO guacamole_connection_permission "
                 "(entity_id, connection_id, permission) VALUES (:eid, :cid, 'READ')"),
            {"eid": entity_id, "cid": connection_id},
        )


def upsert_guac_user(username: str, password: str) -> bool:
    """创建/更新 Guacamole 用户并确保其拥有专属 RDP 连接。

    用于注册与修改密码场景：账号密码与连接参数在同一事务内提交。
    返回是否实际执行了同步；任何步骤失败都抛异常，由调用方保证整体回滚
    （平台与 Guacamole 不产生半完成状态）。
    """
    if not guac_sync_enabled():
        return False

    engine = create_engine(settings.guac_db_url)
    try:
        with engine.begin() as conn:
            entity_id = _ensure_entity(conn, username)
            _set_user_password(conn, entity_id, password)
            connection_id = _ensure_connection(conn, username, password)
            _grant_read(conn, entity_id, connection_id)
        return True
    finally:
        engine.dispose()


def ensure_user_connection(username: str) -> Optional[int]:
    """为已存在于 Guacamole 的用户补齐专属连接（老用户补偿/连接被误删）。

    与 :func:`upsert_guac_user` 不同，本函数不掌握明文密码，因此只创建
    连接与授权、不改动账号密码（自动登录参数中不写 password）。
    用户在 Guacamole 中不存在时返回 None（调用方应提示用户改密或联系管理员）。
    """
    if not guac_sync_enabled():
        return None

    engine = create_engine(settings.guac_db_url)
    try:
        with engine.begin() as conn:
            row = conn.execute(
                text("SELECT entity_id FROM guacamole_entity "
                     "WHERE name = :name AND type = 'USER'"),
                {"name": username},
            ).first()
            if not row:
                return None
            entity_id = row[0]
            connection_id = _ensure_connection(conn, username, None)
            _grant_read(conn, entity_id, connection_id)
        return connection_id
    finally:
        engine.dispose()


def get_user_connection_id(username: str) -> Optional[int]:
    """按用户名查询其专属 RDP 连接 ID，不存在返回 None"""
    if not guac_sync_enabled():
        return None

    engine = create_engine(settings.guac_db_url)
    try:
        with engine.connect() as conn:
            return conn.execute(
                text("SELECT connection_id FROM guacamole_connection "
                     "WHERE connection_name = :n"),
                {"n": _connection_name(username)},
            ).scalar_one_or_none()
    finally:
        engine.dispose()
