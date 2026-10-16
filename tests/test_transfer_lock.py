"""upload_file_to_windows 的私有 ACL 锁定（lock_owner）单元测试。

不触网：SFTP/SSH 全部用内存替身，重点校验投递后确实对目录与文件
各执行了一次 icacls 收敛，且 owner 经白名单校验防命令注入。
"""
import pytest

import app.transfer as transfer


class _FakeChannel:
    def __init__(self, code=0):
        self._code = code

    def recv_exit_status(self):
        return self._code


class _FakeExecStream:
    def __init__(self, channel, data=b""):
        self.channel = channel
        self._data = data

    def read(self):
        return self._data


class _FakeSFTP:
    def __init__(self):
        self.put_calls = []

    def stat(self, path):
        raise FileNotFoundError(path)

    def mkdir(self, path):
        pass

    def put(self, local_path, remote_path):
        self.put_calls.append((local_path, remote_path))

    def close(self):
        pass


class _FakeSSH:
    def __init__(self, exit_code=0):
        self.sftp = _FakeSFTP()
        self.commands = []
        self._exit = exit_code
        self.closed = False

    def open_sftp(self):
        return self.sftp

    def exec_command(self, command, timeout=None):
        self.commands.append(command)
        ch = _FakeChannel(self._exit)
        stdin = _FakeExecStream(ch)
        stdout = _FakeExecStream(ch, b"processed file: a.xlsx")
        stderr = _FakeExecStream(ch, b"")
        return stdin, stdout, stderr

    def close(self):
        self.closed = True


@pytest.fixture
def fake_transfer(monkeypatch, tmp_path):
    fake = _FakeSSH()
    monkeypatch.setattr(transfer, "_connect_sftp", lambda: (fake.sftp, fake))
    local = tmp_path / "testData_20260101_000000.xlsx"
    local.write_bytes(b"xlsx")
    return fake, str(local)


def test_upload_without_owner_skips_icacls(fake_transfer):
    fake, local = fake_transfer
    transfer.upload_file_to_windows(local, remote_dir="C:/StatsData",
                                    remote_name="a.xlsx")
    assert fake.commands == []
    assert fake.closed


def test_upload_with_owner_locks_dir_and_file(fake_transfer):
    fake, local = fake_transfer
    win_path = transfer.upload_file_to_windows(
        local, remote_dir="C:/workspace/user2", remote_name="a.xlsx",
        lock_owner="user2",
    )

    assert win_path == r"C:\workspace\user2\a.xlsx"
    assert len(fake.commands) == 2
    dir_cmd, file_cmd = fake.commands

    # 目录：断开继承 + 本人完全控制（带继承标志）+ SYSTEM/Administrators
    assert r'icacls "C:\workspace\user2"' in dir_cmd
    assert "/inheritance:r" in dir_cmd
    assert '"user2:(OI)(CI)F"' in dir_cmd
    assert '"*S-1-5-18:(OI)(CI)F"' in dir_cmd
    assert '"*S-1-5-32-544:(OI)(CI)F"' in dir_cmd

    # 文件本身也要锁（防止投递瞬间继承来的他人读权限残留在文件上）
    assert r'icacls "C:\workspace\user2\a.xlsx"' in file_cmd
    assert '"user2:F"' in file_cmd
    assert "(OI)(CI)" not in file_cmd.split('"user2')[1]


def test_upload_rejects_illegal_owner(fake_transfer, monkeypatch):
    fake, local = fake_transfer

    def _must_not_connect():
        raise AssertionError("非法 owner 不应建立连接")

    monkeypatch.setattr(transfer, "_connect_sftp", _must_not_connect)
    with pytest.raises(ValueError):
        transfer.upload_file_to_windows(local, lock_owner="../evil")


def test_upload_raises_when_icacls_fails(fake_transfer):
    fake, local = fake_transfer
    fake._exit = 5
    with pytest.raises(RuntimeError, match="权限锁定失败"):
        transfer.upload_file_to_windows(
            local, remote_dir="C:/workspace/user2", lock_owner="user2")
    assert fake.closed
