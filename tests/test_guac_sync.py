"""Guacamole 用户同步、专属 RDP 连接 + 修改密码接口测试

用 SQLite 临时文件模拟 Guacamole 的 JDBC 认证库（表结构为
guacamole-auth-jdbc 标准 schema 的最小子集），验证：
- 注册时同步创建 guac 用户（同密码）并创建**专属 RDP 连接**（一人一连接）
- 连接参数按用户名映射（RDP 用户名锁定本人），用户仅有自己连接的 READ 权限
- 改密时两边同步更新（含连接参数中的 RDP 密码）
- 老用户补偿（ensure_user_connection）与 /session/connect 返回专属连接 URL
- 未配置 guac_db_url 时静默跳过，/session/connect 回退共享连接
- guac 同步失败时注册整体失败（平台不产生半完成账号）
"""
import hashlib

import pytest
from sqlalchemy import create_engine, text

from app.config import settings
from app.auth import verify_password_hash
from app.guac import ensure_user_connection, get_user_connection_id
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
CREATE TABLE guacamole_connection (
    connection_id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_name VARCHAR(128) NOT NULL,
    protocol VARCHAR(32) NOT NULL,
    failover_only INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE guacamole_connection_parameter (
    connection_id INTEGER NOT NULL,
    parameter_name VARCHAR(128) NOT NULL,
    parameter_value VARCHAR(4096) NOT NULL,
    PRIMARY KEY (connection_id, parameter_name)
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


def _query_connection(engine, username):
    """返回 (connection_id, {参数名: 值}, 该用户的权限列表)"""
    name = f"{settings.guac_connection_prefix}{username}"
    with engine.connect() as conn:
        cid = conn.execute(
            text("SELECT connection_id FROM guacamole_connection WHERE connection_name = :n"),
            {"n": name},
        ).scalar_one_or_none()
        if cid is None:
            return None
        params = dict(conn.execute(
            text("SELECT parameter_name, parameter_value FROM guacamole_connection_parameter "
                 "WHERE connection_id = :cid"),
            {"cid": cid},
        ).all())
        perms = [r[0] for r in conn.execute(
            text("SELECT c.connection_id FROM guacamole_entity e "
                 "JOIN guacamole_connection_permission c ON c.entity_id = e.entity_id "
                 "WHERE e.name = :n AND e.type = 'USER'"),
            {"n": username},
        ).all()]
        return cid, params, perms


# ---------- 注册同步：专属连接 ----------

def test_register_creates_dedicated_connection(client, db_session, guac_db):
    resp = client.post("/auth/register", json={
        "username": "guacuser", "password": "guacpass123", "display_name": "Guac用户",
    })
    assert resp.status_code == 200

    # guac 账号 + 同密码
    row = _query_guac_user(guac_db, "guacuser")
    assert row is not None, "Guacamole 库中应创建同名用户"
    assert row[0] == _guac_hash("guacpass123", row[1])

    # 专属连接
    result = _query_connection(guac_db, "guacuser")
    assert result is not None, "应为用户创建专属 RDP 连接"
    cid, params, perms = result
    assert params["hostname"] == settings.rds_host
    assert params["port"] == str(settings.rds_port)
    # RDP 用户名锁定为本人，RDP 密码与平台一致（自动登录）
    assert params["username"] == "guacuser"
    assert params["password"] == "guacpass123"
    # 用户只有自己这一条连接的权限
    assert perms == [cid]


def test_two_users_have_isolated_connections(client, db_session, guac_db):
    client.post("/auth/register", json={"username": "alice", "password": "passalice1"})
    client.post("/auth/register", json={"username": "bob", "password": "passbob222"})

    a = _query_connection(guac_db, "alice")
    b = _query_connection(guac_db, "bob")
    assert a is not None and b is not None
    assert a[0] != b[0], "两个用户的连接必须不同"
    # 各自只能看到自己的连接
    assert a[2] == [a[0]]
    assert b[2] == [b[0]]
    # 连接参数中的 RDP 身份互不串用
    assert a[1]["username"] == "alice" and a[1]["password"] == "passalice1"
    assert b[1]["username"] == "bob" and b[1]["password"] == "passbob222"


def test_register_idempotent_connection_on_rerun(client, db_session, guac_db):
    client.post("/auth/register", json={"username": "repeat", "password": "pass123456"})
    # 再次直接调用同步（模拟改密），连接不应重复创建
    from app.guac import upsert_guac_user
    upsert_guac_user("repeat", "newpass789")
    with guac_db.connect() as conn:
        count = conn.execute(
            text("SELECT COUNT(*) FROM guacamole_connection WHERE connection_name = :n"),
            {"n": f"{settings.guac_connection_prefix}repeat"},
        ).scalar_one()
    assert count == 1, "重复同步不应产生重复连接"


def test_auto_login_disabled_omits_credentials(client, db_session, guac_db, monkeypatch):
    monkeypatch.setattr(settings, "guac_rdp_auto_login", False)
    client.post("/auth/register", json={"username": "manual", "password": "pass123456"})
    _, params, _ = _query_connection(guac_db, "manual")
    assert "username" not in params and "password" not in params
    assert params["hostname"] == settings.rds_host


def test_drive_and_recording_paths_isolated_per_user(client, db_session, guac_db, monkeypatch):
    monkeypatch.setattr(settings, "guac_drive_root", "/guacd/drives")
    monkeypatch.setattr(settings, "guac_recording_root", "/guacd/records")
    client.post("/auth/register", json={"username": "iso", "password": "pass123456"})
    _, params, _ = _query_connection(guac_db, "iso")
    assert params["drive-path"] == "/guacd/drives/iso"
    assert params["recording-path"] == "/guacd/records/iso"
    assert params["enable-drive"] == "true"
    assert params["enable-recording"] == "true"


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

    # guac 侧：哈希同步更新
    row = _query_guac_user(guac_db, "pwduser")
    assert row[0] == _guac_hash("newpass456", row[1])

    # 专属连接参数中的 RDP 密码也同步更新
    _, params, _ = _query_connection(guac_db, "pwduser")
    assert params["password"] == "newpass456"

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


# ---------- 老用户补偿 + /session/connect ----------

def test_ensure_connection_for_existing_guac_user(client, db_session, guac_db):
    """老用户：guac 账号已存在但没有专属连接，补偿创建且不改密码"""
    # 手工造一个只有账号、没有连接的老用户
    with guac_db.begin() as conn:
        conn.execute(text("INSERT INTO guacamole_entity (name, type) VALUES ('legacy','USER')"))
        eid = conn.execute(
            text("SELECT entity_id FROM guacamole_entity WHERE name='legacy'")
        ).scalar_one()
        salt = b"\x11" * 32
        old_hash = _guac_hash("legacypwd", salt)
        conn.execute(
            text("INSERT INTO guacamole_user (entity_id,password_hash,password_salt,password_date,"
                 "disabled,expired) VALUES (:e,:h,:s,'2026-01-01 00:00:00',0,0)"),
            {"e": eid, "h": old_hash, "s": salt},
        )

    cid = ensure_user_connection("legacy")
    assert cid is not None
    assert get_user_connection_id("legacy") == cid
    # 密码哈希未被改动
    row = _query_guac_user(guac_db, "legacy")
    assert row[0] == old_hash


def test_ensure_connection_returns_none_for_unknown_user(client, db_session, guac_db):
    assert ensure_user_connection("ghost") is None


def test_session_connect_uses_dedicated_connection(client, db_session, guac_db):
    client.post("/auth/register", json={"username": "sess", "password": "pass123456"})
    login = client.post("/auth/login", json={"username": "sess", "password": "pass123456"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.post("/session/connect", headers=headers)
    assert resp.status_code == 200
    cid = get_user_connection_id("sess")
    assert resp.json()["guac_url"].endswith(str(cid))


def test_session_connect_fallback_when_sync_disabled(client, db_session, test_user, monkeypatch):
    monkeypatch.setattr(settings, "guac_db_url", "")
    login = client.post("/auth/login", json={"username": "user1", "password": "user123"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    resp = client.post("/session/connect", headers=headers)
    assert resp.status_code == 200
    assert settings.guacamole_connection_id in resp.json()["guac_url"]


def test_session_connect_503_when_user_missing_in_guac(client, db_session, guac_db):
    """guac 已启用，但该用户在 guac 中不存在也无法补偿（平台手工造的用户）→ 503"""
    # 直接在平台库造用户，绕过注册同步
    from app.auth import hash_password
    db_session.add(User(username="orphan", display_name="孤儿",
                        password_hash=hash_password("pass123456"), role="user", is_active=True))
    db_session.commit()
    login = client.post("/auth/login", json={"username": "orphan", "password": "pass123456"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    resp = client.post("/session/connect", headers=headers)
    assert resp.status_code == 503
