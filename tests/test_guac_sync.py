"""Guacamole 用户同步 + 修改密码接口测试

用 SQLite 临时文件模拟 Guacamole 的 JDBC 认证库（表结构为
guacamole-auth-jdbc 标准 schema 的最小子集），验证：
- 注册时同步创建 guac 用户（同密码、授予连接 READ 权限）
- 改密时两边同步更新（先 guac 后平台，guac 失败平台不变）
- 未配置 guac_db_url 时静默跳过
- guac 同步失败时注册整体失败（平台不产生半完成账号）
"""
import hashlib

import pytest
from sqlalchemy import create_engine, text

from app.config import settings
from app.auth import verify_password_hash
from app.models import User

# guacamole-auth-jdbc schema 最小子集
_GUAC_SCHEMA = """
CREATE TABLE guacamole_entity (
    entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(128) NOT NULL,
    type VARCHAR(16) NOT NULL,
    UNIQUE (name, type)
);
CREATE TABLE guacamole_user (
    entity_id INTEGER PRIMARY KEY,
    password_hash BLOB(32) NOT NULL,
    password_salt BLOB(32) NOT NULL,
    password_date TIMESTAMP NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    expired INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE guacamole_connection_permission (
    entity_id INTEGER NOT NULL,
    connection_id INTEGER NOT NULL,
    permission VARCHAR(16) NOT NULL,
    PRIMARY KEY (entity_id, connection_id, permission)
);
"""


def _guac_hash(password: str, salt: bytes) -> bytes:
    """按 guacamole-auth-jdbc 标准重算哈希，用于断言"""
    return hashlib.sha256(password.encode("utf-8") + salt.hex().encode("utf-8")).digest()


@pytest.fixture
def guac_db(tmp_path, monkeypatch):
    """建一个模拟的 Guacamole JDBC 库，并让 settings 指向它"""
    db_file = tmp_path / "guac.db"
    engine = create_engine(f"sqlite:///{db_file}")
    with engine.begin() as conn:
        for stmt in _GUAC_SCHEMA.strip().split(";"):
            conn.execute(text(stmt.strip()))
    monkeypatch.setattr(settings, "guac_db_url", f"sqlite:///{db_file}")
    yield engine
    engine.dispose()


def _query_guac_user(engine, username):
    with engine.connect() as conn:
        return conn.execute(
            text("SELECT u.password_hash, u.password_salt, u.disabled, u.expired "
                 "FROM guacamole_entity e JOIN guacamole_user u ON u.entity_id = e.entity_id "
                 "WHERE e.name = :n AND e.type = 'USER'"),
            {"n": username},
        ).first()


def _query_guac_permission(engine, username):
    with engine.connect() as conn:
        return conn.execute(
            text("SELECT p.connection_id, p.permission FROM guacamole_entity e "
                 "JOIN guacamole_connection_permission p ON p.entity_id = e.entity_id "
                 "WHERE e.name = :n AND e.type = 'USER'"),
            {"n": username},
        ).all()


# ---------- 注册同步 ----------

def test_register_creates_guac_user_with_same_password(client, db_session, guac_db):
    resp = client.post("/auth/register", json={
        "username": "guacuser", "password": "guacpass123", "display_name": "Guac用户",
    })
    assert resp.status_code == 200

    row = _query_guac_user(guac_db, "guacuser")
    assert row is not None, "Guacamole 库中应创建同名用户"
    pwd_hash, salt, disabled, expired = row
    assert pwd_hash == _guac_hash("guacpass123", salt), "guac 密码哈希应与注册密码一致"
    assert disabled == 0 and expired == 0

    perms = _query_guac_permission(guac_db, "guacuser")
    assert (int(settings.guacamole_connection_id), "READ") in perms, "应授予通用 RDP 连接 READ 权限"


def test_register_skips_guac_when_not_configured(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "guac_db_url", "")
    resp = client.post("/auth/register", json={"username": "plainuser", "password": "pass123"})
    assert resp.status_code == 200


def test_register_fails_when_guac_sync_fails(client, db_session, monkeypatch):
    """guac 同步失败 → 注册 502，平台不创建用户"""
    monkeypatch.setattr(settings, "guac_db_url", "sqlite:////nonexistent_dir_xyz/guac.db")
    resp = client.post("/auth/register", json={"username": "failuser", "password": "pass123"})
    assert resp.status_code == 502
    assert "Guacamole" in resp.json()["detail"]
    assert db_session.query(User).filter(User.username == "failuser").first() is None


# ---------- 修改密码 ----------

def _register_and_login(client, username="pwduser", password="oldpass123"):
    client.post("/auth/register", json={"username": username, "password": password})
    resp = client.post("/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def test_change_password_syncs_both_sides(client, db_session, guac_db):
    headers = _register_and_login(client)

    resp = client.post("/auth/change-password",
                       json={"old_password": "oldpass123", "new_password": "newpass456"},
                       headers=headers)
    assert resp.status_code == 200

    # 平台侧：新密码 hash 生效，旧密码失效
    user = db_session.query(User).filter(User.username == "pwduser").first()
    assert verify_password_hash("newpass456", user.password_hash)
    assert not verify_password_hash("oldpass123", user.password_hash)

    # guac 侧：哈希同步更新为新密码
    row = _query_guac_user(guac_db, "pwduser")
    assert row[0] == _guac_hash("newpass456", row[1])

    # 登录验证：旧密码 401，新密码 200
    assert client.post("/auth/login", json={"username": "pwduser", "password": "oldpass123"}).status_code == 401
    assert client.post("/auth/login", json={"username": "pwduser", "password": "newpass456"}).status_code == 200


def test_change_password_wrong_old_password(client, db_session, guac_db):
    headers = _register_and_login(client)
    resp = client.post("/auth/change-password",
                       json={"old_password": "wrongpass", "new_password": "newpass456"},
                       headers=headers)
    assert resp.status_code == 400
    assert "原密码" in resp.json()["detail"]


def test_change_password_guac_failure_keeps_platform_password(client, db_session, monkeypatch):
    """改密时 guac 同步失败 → 502，平台密码不变"""
    monkeypatch.setattr(settings, "guac_db_url", "")
    headers = _register_and_login(client)

    monkeypatch.setattr(settings, "guac_db_url", "sqlite:////nonexistent_dir_xyz/guac.db")
    resp = client.post("/auth/change-password",
                       json={"old_password": "oldpass123", "new_password": "newpass456"},
                       headers=headers)
    assert resp.status_code == 502

    # 平台密码未被修改
    user = db_session.query(User).filter(User.username == "pwduser").first()
    assert verify_password_hash("oldpass123", user.password_hash)


def test_change_password_demo_account_forbidden(client, db_session, admin_headers):
    resp = client.post("/auth/change-password",
                       json={"old_password": "admin123", "new_password": "newpass456"},
                       headers=admin_headers)
    assert resp.status_code == 400
    assert "演示账号" in resp.json()["detail"]


def test_change_password_requires_auth(client):
    resp = client.post("/auth/change-password",
                       json={"old_password": "a", "new_password": "newpass456"})
    assert resp.status_code == 401
