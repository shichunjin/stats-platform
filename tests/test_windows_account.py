"""Windows 云主机账号同步测试：SSH 层全部用 FakeSSH 替身，不触网。"""
import base64
import re

import pytest

from app.config import settings
from app.models import User
from app.windows_account import (
    WindowsAccountError,
    sync_windows_user,
    validate_windows_username,
)
import app.windows_account as wa


# ---- SSH 替身 ----

class _FakeChannel:
    def __init__(self, code: int):
        self._code = code
        self.closed_write = False

    def recv_exit_status(self) -> int:
        return self._code

    def shutdown_write(self):
        self.closed_write = True


class _FakeStdin:
    def __init__(self, channel: _FakeChannel):
        self.channel = channel
        self.script = ""

    def write(self, data: str):
        self.script += data

    def flush(self):
        pass

    def shutdown_write(self):
        self.channel.shutdown_write()


class _FakeStream:
    def __init__(self, channel: _FakeChannel, text: str):
        self.channel = channel
        self._bytes = text.encode("utf-8")

    def read(self) -> bytes:
        return self._bytes


class FakeSSH:
    """记录 exec_command 调用并返回可控输出"""

    def __init__(self, exit_code: int = 0, out: str = "STATS_WINDOWS_USER_CREATED",
                 err: str = "", connect_exc: Exception | None = None):
        self.exit_code = exit_code
        self.out = out
        self.err = err
        self.connect_exc = connect_exc
        self.calls: list[tuple[str, _FakeStdin]] = []
        self.closed = False

    def __call__(self) -> "FakeSSH":
        if self.connect_exc:
            raise self.connect_exc
        return self

    def exec_command(self, command: str, timeout=None):
        ch = _FakeChannel(self.exit_code)
        stdin = _FakeStdin(ch)
        self.calls.append((command, stdin))
        return stdin, _FakeStream(ch, self.out), _FakeStream(ch, self.err)

    def close(self):
        self.closed = True


def _decode_payload(stdin_text: str) -> str:
    """从 stdin 包装器中提取并解码 UTF-16LE Base64 载荷（实际执行的 PS 脚本）"""
    m = re.search(r"FromBase64String\('([^']+)'\)", stdin_text)
    assert m, "stdin 应包含 Base64 载荷"
    return base64.b64decode(m.group(1)).decode("utf-16-le")


# ---- 单元测试：用户名规则 ----

@pytest.mark.parametrize("bad", ["ab", "a" * 21, "张三", "bad name", "a@b", "a/b",
                                  'a"b', "a;b", "a*b", "a?b", "", "a|b"])
def test_invalid_windows_usernames(bad):
    with pytest.raises(WindowsAccountError):
        validate_windows_username(bad)


@pytest.mark.parametrize("good", ["abc", "user.name-1_x", "A" * 20, "u01"])
def test_valid_windows_usernames(good):
    validate_windows_username(good)  # 不抛异常即可


# ---- 单元测试：同步执行 ----

def test_sync_disabled_skips_ssh(monkeypatch):
    monkeypatch.setattr(settings, "windows_account_sync", False)
    fake = FakeSSH()
    monkeypatch.setattr(wa, "connect_ssh", fake)

    assert sync_windows_user("alice", "Passw0rd!") is False
    assert fake.calls == []


def test_sync_creates_account_with_expected_script(monkeypatch):
    monkeypatch.setattr(settings, "windows_account_sync", True)
    fake = FakeSSH()
    monkeypatch.setattr(wa, "connect_ssh", fake)

    # 含单引号的密码：验证 PowerShell 单引号转义（' -> ''）
    assert sync_windows_user("alice", "a'b$c") is True

    assert len(fake.calls) == 1
    command, stdin = fake.calls[0]
    assert "powershell" in command and "-Command -" in command
    assert stdin.channel.closed_write  # 必须关闭 stdin 写端，远端才会执行
    assert fake.closed

    # stdin 包装器本身必须是纯 ASCII（绕开 GBK 代码页问题）
    stdin_text = stdin.script
    assert stdin_text.isascii()
    inner = _decode_payload(stdin_text)

    assert "$username = 'alice'" in inner
    assert "$password = 'a''b$c'" in inner
    assert "New-LocalUser" in inner
    assert "Set-LocalUser" in inner
    assert "S-1-5-32-545" in inner   # Users
    assert "S-1-5-32-555" in inner   # Remote Desktop Users
    # 语言无关的幂等加组：成员预检 + MemberExists 错误码（不能匹配英文报错文本）
    assert "Ensure-GroupMember" in inner
    assert "MemberExists" in inner
    assert "already a member" not in inner


def test_sync_remote_nonzero_exit_raises(monkeypatch):
    monkeypatch.setattr(settings, "windows_account_sync", True)
    fake = FakeSSH(exit_code=1, err="Set-LocalUser : 密码不满足长度、复杂性或历史要求")
    monkeypatch.setattr(wa, "connect_ssh", fake)

    with pytest.raises(WindowsAccountError, match="Windows 账号同步失败"):
        sync_windows_user("alice", "123")
    assert fake.closed


def test_sync_ssh_connection_error_raises(monkeypatch):
    monkeypatch.setattr(settings, "windows_account_sync", True)
    fake = FakeSSH(connect_exc=OSError("connection refused"))
    monkeypatch.setattr(wa, "connect_ssh", fake)

    with pytest.raises(WindowsAccountError, match="无法连接 Windows 云主机"):
        sync_windows_user("alice", "Passw0rd!")


def test_sync_password_control_char_rejected(monkeypatch):
    monkeypatch.setattr(settings, "windows_account_sync", True)
    with pytest.raises(WindowsAccountError, match="控制字符"):
        sync_windows_user("alice", "bad\npassword")


def test_decode_remote_gbk_fallback():
    """中文版 Windows 的 GBK 错误输出应能正确解码而不是乱码"""
    text = "已经是 Remote Desktop Users 组的成员"
    assert wa._decode_remote(text.encode("gbk")) == text
    assert wa._decode_remote(text.encode("utf-8")) == text


# ---- 集成测试：注册链路 ----

@pytest.fixture
def windows_enabled(monkeypatch):
    """启用 Windows 同步、关闭 Guacamole 同步，注入 FakeSSH，返回 fake"""
    monkeypatch.setattr(settings, "windows_account_sync", True)
    monkeypatch.setattr(settings, "guac_db_url", "")
    fake = FakeSSH()
    monkeypatch.setattr(wa, "connect_ssh", fake)
    return fake


def test_register_invokes_windows_sync(client, db_session, windows_enabled):
    resp = client.post("/auth/register",
                       json={"username": "winuser", "password": "Winpass1"})
    assert resp.status_code == 200

    assert len(windows_enabled.calls) == 1
    inner = _decode_payload(windows_enabled.calls[0][1].script)
    assert "$username = 'winuser'" in inner
    assert "$password = 'Winpass1'" in inner

    # 平台账号已落库
    assert db_session.query(User).filter(User.username == "winuser").count() == 1


def test_register_windows_failure_rolls_back(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "windows_account_sync", True)
    monkeypatch.setattr(settings, "guac_db_url", "")
    fake = FakeSSH(exit_code=1, err="密码不满足复杂性要求")
    monkeypatch.setattr(wa, "connect_ssh", fake)

    # 密码本身合规（API 策略放行），但远端 Windows 因策略/服务问题失败
    resp = client.post("/auth/register",
                       json={"username": "winuser2", "password": "Win@2026ab"})
    assert resp.status_code == 502
    assert "Windows 账号同步失败" in resp.json()["detail"]
    # 平台账号不得创建
    assert db_session.query(User).filter(User.username == "winuser2").count() == 0


def test_register_skipped_when_sync_disabled(client, db_session, monkeypatch):
    # conftest 默认 WINDOWS_ACCOUNT_SYNC=false
    def _must_not_connect():
        raise AssertionError("同步关闭时不应连接 Windows")

    monkeypatch.setattr(wa, "connect_ssh", _must_not_connect)
    resp = client.post("/auth/register",
                       json={"username": "winuser3", "password": "Winpass3"})
    assert resp.status_code == 200


def test_register_invalid_username_rejected_422(client, windows_enabled):
    resp = client.post("/auth/register",
                       json={"username": "bad name", "password": "Winpass1"})
    assert resp.status_code == 422
    assert windows_enabled.calls == []  # 非法用户名不得触达 Windows


# ---- 集成测试：改密链路 ----

def test_change_password_syncs_to_windows(client, db_session, monkeypatch):
    # 先在同步关闭状态下注册
    resp = client.post("/auth/register",
                       json={"username": "pwdwin", "password": "Oldpass1"})
    assert resp.status_code == 200

    monkeypatch.setattr(settings, "windows_account_sync", True)
    monkeypatch.setattr(settings, "guac_db_url", "")
    fake = FakeSSH()
    monkeypatch.setattr(wa, "connect_ssh", fake)

    login = client.post("/auth/login",
                        json={"username": "pwdwin", "password": "Oldpass1"})
    headers = {"Authorization": f"Bearer {login.json()['access_token']}"}

    resp = client.post("/auth/change-password", headers=headers,
                       json={"old_password": "Oldpass1", "new_password": "Newpass2"})
    assert resp.status_code == 200
    inner = _decode_payload(fake.calls[0][1].script)
    assert "$username = 'pwdwin'" in inner
    assert "$password = 'Newpass2'" in inner
    assert "Oldpass1" not in inner

    # Windows 失败时平台密码必须保持不变（新密码本身合规，失败来自远端）
    fake.exit_code = 1
    fake.err = "密码不满足复杂性要求"
    resp = client.post("/auth/change-password", headers=headers,
                       json={"old_password": "Newpass2", "new_password": "New@9999"})
    assert resp.status_code == 502

    # 原密码仍可登录（平台未改）
    again = client.post("/auth/login",
                        json={"username": "pwdwin", "password": "Newpass2"})
    assert again.status_code == 200
