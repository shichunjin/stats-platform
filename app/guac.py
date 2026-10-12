"""Guacamole (guacamole-auth-jdbc) 用户同步

平台注册/修改密码时，在 Guacamole 的 JDBC 认证库中创建或更新同名用户，
保证两边用户名、密码始终一致。

密码算法遵循 guacamole-auth-jdbc 标准：
    password_salt = 32 字节随机盐
    password_hash = SHA256( 明文密码(UTF-8) + salt 的小写 hex 字符串(UTF-8) )

同时为新用户授予通用 RDP 连接（settings.guacamole_connection_id）的 READ
权限，否则用户登录 Guacamole 后看不到任何连接。

未配置 settings.guac_db_url 时所有函数静默跳过（本地开发/测试环境）。
"""
import hashlib
import secrets
from datetime import datetime

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


def upsert_guac_user(username: str, password: str) -> bool:
    """在 Guacamole JDBC 库中创建或更新用户（密码重置为指定明文）。

    返回是否实际执行了同步；同步失败抛出异常，由调用方决定如何处理
    （注册/改密场景应整体失败，保证两边密码一致）。
    """
    if not guac_sync_enabled():
        return False

    salt = secrets.token_bytes(32)
    pwd_hash = _hash_password(password, salt)
    now = datetime.utcnow()

    engine = create_engine(settings.guac_db_url)
    try:
        with engine.begin() as conn:
            row = conn.execute(
                text("SELECT entity_id FROM guacamole_entity "
                     "WHERE name = :name AND type = 'USER'"),
                {"name": username},
            ).first()

            if row:
                # 已有实体：更新密码（guacamole_user 行可能不存在，先 UPDATE 再补 INSERT）
                entity_id = row[0]
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
            else:
                # 新用户：先建实体，再建用户行
                conn.execute(
                    text("INSERT INTO guacamole_entity (name, type) VALUES (:name, 'USER')"),
                    {"name": username},
                )
                entity_id = conn.execute(
                    text("SELECT entity_id FROM guacamole_entity "
                         "WHERE name = :name AND type = 'USER'"),
                    {"name": username},
                ).scalar_one()
                conn.execute(
                    text("INSERT INTO guacamole_user "
                         "(entity_id, password_hash, password_salt, password_date, disabled, expired) "
                         "VALUES (:eid, :h, :s, :d, 0, 0)"),
                    {"eid": entity_id, "h": pwd_hash, "s": salt, "d": now},
                )

            # 授予通用 RDP 连接的 READ 权限（数字 ID 才有效；user-mapping 认证无此概念）
            conn_id = settings.guacamole_connection_id
            if conn_id and conn_id.isdigit():
                exists = conn.execute(
                    text("SELECT 1 FROM guacamole_connection_permission "
                         "WHERE entity_id = :eid AND connection_id = :cid AND permission = 'READ'"),
                    {"eid": entity_id, "cid": int(conn_id)},
                ).first()
                if not exists:
                    conn.execute(
                        text("INSERT INTO guacamole_connection_permission "
                             "(entity_id, connection_id, permission) VALUES (:eid, :cid, 'READ')"),
                        {"eid": entity_id, "cid": int(conn_id)},
                    )
        return True
    finally:
        engine.dispose()
