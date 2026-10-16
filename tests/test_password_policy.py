"""密码强度策略单元测试 + 注册/改密接口的前置拦截测试"""
import pytest

from app.auth import validate_password_strength
from app.config import settings
import app.windows_account as wa


# ---- 单元：validate_password_strength ----

@pytest.mark.parametrize("password", [
    "Aa123456",              # 大写+小写+数字
    "Abcdefg1",              # 大写+小写+数字
    "Abcdefg!",              # 大写+小写+符号
    "abcdef1!",              # 小写+数字+符号
    "ABCDEF1!",              # 大写+数字+符号
    "Aa1!aaaa",              # 四类齐全
    "Aa1!" + "x" * 60,       # 最大长度边界（64 位）
])
def test_strong_passwords_pass(password):
    validate_password_strength(password, "someuser")  # 不抛异常即可


@pytest.mark.parametrize("password,reason", [
    ("Aa12345", "长度不足 8 位"),
    ("A" * 65, "长度超 64 位"),
    ("abcdefgh", "仅小写"),
    ("ABCDEFGH", "仅大写"),
    ("12345678", "仅数字"),
    ("aaaaaaaa", "仅一类字符"),
    ("Abcdefgh", "仅大写+小写两类"),
    ("abcd1234", "仅小写+数字两类"),
    ("ABCD1234", "仅大写+数字两类"),
    ("Aa  1234", "含空格"),
])
def test_weak_passwords_rejected(password, reason):
    with pytest.raises(ValueError):
        validate_password_strength(password, "someuser")


@pytest.mark.parametrize("username,password", [
    ("john", "John@2026xyz"),     # 完整包含用户名
    ("JOHN", "john@2026xyz"),     # 大小写不敏感
    ("alice01", "xAlice01@ab"),   # 中间包含
])
def test_password_containing_username_rejected(username, password):
    with pytest.raises(ValueError, match="用户名"):
        validate_password_strength(password, username)


def test_short_username_not_checked():
    # 用户名不足 3 位时不做包含检查
    validate_password_strength("Aa123456", "ab")


# ---- 接口：注册前置拦截，不触达任何外部系统 ----

def test_register_weak_password_422_no_sync(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "windows_account_sync", True)

    def _must_not_connect():
        raise AssertionError("弱密码不应触达 Windows")

    monkeypatch.setattr(wa, "connect_ssh", _must_not_connect)

    resp = client.post("/auth/register",
                       json={"username": "weakpwd", "password": "abcdefgh"})
    assert resp.status_code == 422
    assert "三类" in resp.json()["detail"]

    from app.models import User
    assert db_session.query(User).filter(User.username == "weakpwd").count() == 0


def test_register_password_with_username_422(client):
    resp = client.post("/auth/register",
                       json={"username": "robert", "password": "Robert@2026ab"})
    assert resp.status_code == 422
    assert "用户名" in resp.json()["detail"]


def test_register_too_short_password_422_schema_level(client):
    # 小于 8 位在 Pydantic 层即被拒
    resp = client.post("/auth/register",
                       json={"username": "robert", "password": "Aa123"})
    assert resp.status_code == 422


# ---- 接口：改密前置拦截，平台密码保持不变 ----

def test_change_password_weak_new_422_keeps_old(client, db_session, monkeypatch):
    monkeypatch.setattr("app.config.settings.guac_db_url", "")
    resp = client.post("/auth/register",
                       json={"username": "poluser", "password": "Oldpass123"})
    assert resp.status_code == 200

    login = client.post("/auth/login",
                        json={"username": "poluser", "password": "Oldpass123"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.post("/auth/change-password", headers=headers,
                       json={"old_password": "Oldpass123", "new_password": "weaknewpw"})
    assert resp.status_code == 422
    assert "三类" in resp.json()["detail"]

    # 旧密码仍可登录
    again = client.post("/auth/login",
                        json={"username": "poluser", "password": "Oldpass123"})
    assert again.status_code == 200


def test_change_password_strong_new_succeeds(client, monkeypatch):
    monkeypatch.setattr("app.config.settings.guac_db_url", "")
    client.post("/auth/register",
                json={"username": "poluser2", "password": "Oldpass123"})
    login = client.post("/auth/login",
                        json={"username": "poluser2", "password": "Oldpass123"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.post("/auth/change-password", headers=headers,
                       json={"old_password": "Oldpass123", "new_password": "Newpass456"})
    assert resp.status_code == 200

    again = client.post("/auth/login",
                        json={"username": "poluser2", "password": "Newpass456"})
    assert again.status_code == 200
