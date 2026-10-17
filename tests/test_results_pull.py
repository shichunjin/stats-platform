"""「申请导出」SFTP 回拉链路测试：Windows C:\\pending\\{用户名} -> 服务器暂存。

历史缺陷：request-export 只扫描服务器本地 fileserver_root/pending/{id}/，
用户保存在 Windows 待导出目录（RESULTS_DIR）的结果文件永远不会被拉回，
前端恒提示「没有新的结果文件可申请」。
"""
import os
import stat as stat_mod
import types

import pytest

import app.transfer as transfer
from app.config import settings
from app.routers import results as results_routes
# 收集时绑定真实编排函数；conftest 的 autouse fixture 只替换模块属性，
# 这里的引用始终指向原始实现，便于在需要时恢复。
from app.routers.results import pull_user_pending as real_pull


class _Attr:
    def __init__(self, name, size, is_dir=False):
        self.filename = name
        self.st_size = size
        self.st_mode = (stat_mod.S_IFDIR | 0o755) if is_dir else (stat_mod.S_IFREG | 0o644)


class FakeSFTP:
    """模拟 Windows 远端单个 pending 目录。"""

    def __init__(self, files, missing_dirs=()):
        # files: {文件名: 字节}；None 表示这是一个子目录
        self._files = files
        self.missing = set(missing_dirs)
        self.listed: list[str] = []
        self.gets: list[tuple[str, str]] = []

    def listdir_attr(self, remote_dir):
        self.listed.append(remote_dir)
        if remote_dir in self.missing:
            raise FileNotFoundError(remote_dir)
        attrs = []
        for name, blob in self._files.items():
            if blob is None:
                attrs.append(_Attr(name, 0, is_dir=True))
            else:
                attrs.append(_Attr(name, len(blob)))
        return attrs

    def get(self, remote_path, local_path):
        name = remote_path.rsplit("/", 1)[-1]
        self.gets.append((remote_path, local_path))
        with open(local_path, "wb") as f:
            f.write(self._files[name])

    def close(self):
        pass


@pytest.fixture
def remote_sftp(monkeypatch):
    holder = {}

    def _install(files, missing_dirs=()):
        sftp = FakeSFTP(files, missing_dirs=missing_dirs)
        ssh = types.SimpleNamespace(close=lambda: None)
        monkeypatch.setattr(transfer, "_connect_sftp", lambda: (sftp, ssh))
        holder["sftp"] = sftp
        return sftp

    return _install


# ---- 编排函数 pull_user_pending ----

def test_pull_uses_username_dir_and_type_whitelist(test_user, remote_sftp, tmp_path):
    sftp = remote_sftp({
        "model.out": b"regression output",
        "result.xlsx": b"not allowed type",
        "subdir": None,
    })
    local_dir = str(tmp_path / "pending")

    pulled = real_pull(test_user, local_dir)

    # 远端目录必须按用户名（与投递侧、login.ps1 的 RESULTS_DIR 约定一致）
    assert sftp.listed == [f"{settings.windows_pending_dir}/user1"]
    # 只有白名单类型被拉回：.out 进、.xlsx 与子目录不进
    assert pulled == [os.path.join(local_dir, "model.out")]
    assert os.path.isfile(os.path.join(local_dir, "model.out"))
    assert not os.path.exists(os.path.join(local_dir, "result.xlsx"))
    assert all(name.endswith("model.out") for name, _ in sftp.gets)


def test_pull_skips_unchanged_and_refetches_changed(test_user, remote_sftp, tmp_path):
    local_dir = tmp_path / "pending"
    local_dir.mkdir()
    # 本地已存在同名同大小文件：增量跳过，不重复下载
    (local_dir / "model.out").write_bytes(b"abc")
    sftp = remote_sftp({"model.out": b"abc", "new.log": b"ll"})

    pulled = real_pull(test_user, str(local_dir))

    assert [os.path.basename(p) for p in pulled] == ["new.log"]
    assert len(sftp.gets) == 1 and sftp.gets[0][0].endswith("/new.log")

    # 文件大小变化（远端更新）：必须重新下载覆盖
    sftp2 = remote_sftp({"model.out": b"abc-changed"})
    pulled2 = real_pull(test_user, str(local_dir))
    assert [os.path.basename(p) for p in pulled2] == ["model.out"]
    assert (local_dir / "model.out").read_bytes() == b"abc-changed"


def test_pull_remote_dir_missing_returns_empty(test_user, remote_sftp, tmp_path):
    remote_sftp({}, missing_dirs={f"{settings.windows_pending_dir}/user1"})
    assert real_pull(test_user, str(tmp_path / "p")) == []


def test_pull_rejects_path_traversal_name(test_user, remote_sftp, tmp_path):
    sftp = remote_sftp({"../evil.out": b"x", "ok.out": b"y"})
    pulled = real_pull(test_user, str(tmp_path / "p"))
    assert [os.path.basename(p) for p in pulled] == ["ok.out"]
    assert not (tmp_path / "evil.out").exists()


# ---- API：/results/request-export ----

def test_api_register_after_pull(client, auth_headers, test_user, pending_dir,
                                 remote_sftp, monkeypatch):
    monkeypatch.setattr(results_routes, "pull_user_pending", real_pull)
    remote_sftp({"regression.out": b"output line\n"})

    resp = client.post("/results/request-export", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["registered"] == 1
    assert body["files"][0]["file_name"] == "regression.out"

    # 再次申请：文件已登记且远端未变化 -> registered=0
    again = client.post("/results/request-export", headers=auth_headers)
    assert again.status_code == 200
    assert again.json()["registered"] == 0

    mine = client.get("/results/mine", headers=auth_headers).json()
    assert [p["file_name"] for p in mine["pending"]] == ["regression.out"]


def test_api_request_export_502_when_windows_unreachable(
        client, auth_headers, monkeypatch):
    monkeypatch.setattr(results_routes, "pull_user_pending", real_pull)

    def _boom(remote_dir):
        raise OSError("connection refused")

    monkeypatch.setattr(results_routes, "list_remote_files", _boom)

    resp = client.post("/results/request-export", headers=auth_headers)
    assert resp.status_code == 502
    assert "Windows" in resp.json()["detail"]


# ---- transfer 原语 ----

def test_list_remote_files_missing_dir_empty(remote_sftp):
    remote_sftp({}, missing_dirs={"C:/pending/user1"})
    assert transfer.list_remote_files("C:/pending/user1") == []


def test_download_file_creates_parent_dir(remote_sftp, tmp_path):
    remote_sftp({"a.out": b"data"})
    target = str(tmp_path / "nested" / "deep" / "a.out")
    transfer.download_file_from_windows("C:/pending/user1", "a.out", target)
    assert open(target, "rb").read() == b"data"
