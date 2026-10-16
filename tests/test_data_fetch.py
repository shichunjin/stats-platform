"""「获取数据」/data/fetch 文件命名与数据隔离回归测试。

历史缺陷 1：该接口把输出写死为 {DATASET_NAME}.xlsx，每次获取都覆盖
本地 fileserver_root/data/ 与 Windows Z: 盘上的同名文件，历史数据丢失。
修复后要求：时间戳命名、每次独立、SFTP 远端沿用同一文件名。

历史缺陷 2：所有用户的获取结果都推送到公共共享 C:\\StatsData（Z: 盘），
user3 能看到 user2 获取的数据文件。修复后要求：推送到调用者本人的
C:\\workspace\\{用户名}\\（W: 盘），并带 lock_owner 触发 NTFS 私有锁定。
"""
import os
import re

import app.routers.data as data_routes
from app.auth import create_access_token
from app.config import settings
from app.models import User

TS_NAME = re.compile(r"^testData_\d{8}_\d{6}\.xlsx$")


def _patch_generators(monkeypatch, uploaded: list):
    """替换真实 Excel 生成与 SFTP 上传：生成器落一个真实占位文件。"""

    def fake_generate(db, table_name, out_path, *args, **kwargs):
        with open(out_path, "wb") as f:
            f.write(b"fake-xlsx")
        return 10, 3

    def fake_upload(local_path, remote_dir=None, remote_name=None,
                    lock_owner=None):
        name = remote_name or os.path.basename(local_path)
        uploaded.append((local_path, remote_dir, name, lock_owner))
        win_dir = (remote_dir or settings.windows_data_dir).replace("/", "\\")
        return f"{win_dir}\\{name}"

    monkeypatch.setattr(data_routes, "generate_excel_from_table", fake_generate)
    monkeypatch.setattr(data_routes, "upload_file_to_windows", fake_upload)


def _make_user(db_session, scope, username: str) -> str:
    user = User(username=username, display_name=username, dept_id=scope.id,
                role="user", is_active=True)
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    token = create_access_token(user.id, user.username, "user")
    return {"Authorization": f"Bearer {token}"}


def test_fetch_uses_timestamp_filename(client, auth_headers, monkeypatch):
    uploaded = []
    _patch_generators(monkeypatch, uploaded)

    resp = client.post("/data/fetch", headers=auth_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert TS_NAME.match(body["filename"]), body["filename"]
    assert body["filename"] != "testData.xlsx"
    assert os.path.isfile(body["local_path"])
    # 远端必须沿用同一时间戳文件名，而不是固定的 testData.xlsx
    assert uploaded[-1][2] == body["filename"]
    assert body["windows_path"].endswith(body["filename"])


def test_fetch_twice_never_overwrites(client, auth_headers, monkeypatch):
    uploaded = []
    _patch_generators(monkeypatch, uploaded)

    r1 = client.post("/data/fetch", headers=auth_headers).json()
    r2 = client.post("/data/fetch", headers=auth_headers).json()

    assert r1["filename"] != r2["filename"]
    # 两份文件必须同时存在（旧文件没有被覆盖/删除）
    assert os.path.isfile(r1["local_path"])
    assert os.path.isfile(r2["local_path"])
    assert {u[2] for u in uploaded} == {r1["filename"], r2["filename"]}


def test_fetch_same_second_appends_sequence(client, auth_headers, monkeypatch):
    """时间戳撞在同一秒时，第二次必须追加 _2 序号而非覆盖。"""
    uploaded = []
    _patch_generators(monkeypatch, uploaded)
    fixed = "testData_20260101_000000.xlsx"
    monkeypatch.setattr(data_routes, "timestamp_filename", lambda *a, **k: fixed)

    r1 = client.post("/data/fetch", headers=auth_headers).json()
    r2 = client.post("/data/fetch", headers=auth_headers).json()

    assert r1["filename"] == fixed
    assert r2["filename"] == "testData_20260101_000000_2.xlsx"
    assert os.path.isfile(r1["local_path"])
    assert os.path.isfile(r2["local_path"])


# ---- 数据隔离 ----

def test_fetch_delivers_to_callers_private_workspace(client, auth_headers,
                                                     monkeypatch):
    uploaded = []
    _patch_generators(monkeypatch, uploaded)

    resp = client.post("/data/fetch", headers=auth_headers)
    assert resp.status_code == 200

    _local, remote_dir, _name, lock_owner = uploaded[-1]
    assert remote_dir == f"{settings.windows_workspace_dir}/user1"
    assert lock_owner == "user1"
    # 绝不允许再落到公共 Z: 盘目录
    assert "StatsData" not in (remote_dir or "")
    assert "workspace" in resp.json()["windows_path"]


def test_fetch_isolated_between_users(client, db_session, test_scope,
                                      monkeypatch):
    """user2 与 user3 各自获取的数据必须进入不同的私有目录并分别锁定。"""
    uploaded = []
    _patch_generators(monkeypatch, uploaded)

    h2 = _make_user(db_session, test_scope, "user2")
    h3 = _make_user(db_session, test_scope, "user3")

    assert client.post("/data/fetch", headers=h2).status_code == 200
    assert client.post("/data/fetch", headers=h3).status_code == 200

    by_owner = {u[3]: u for u in uploaded}
    assert set(by_owner) == {"user2", "user3"}
    assert by_owner["user2"][1].endswith("/workspace/user2")
    assert by_owner["user3"][1].endswith("/workspace/user3")
    assert by_owner["user2"][1] != by_owner["user3"][1]


def test_generate_locks_target_user_workspace(client, admin_headers,
                                              db_session, test_scope,
                                              monkeypatch):
    """管理员「筛选生成」必须投到目标用户目录并以目标用户身份锁定。"""
    uploaded = []

    def fake_filtered(db, table_name, out_path, filters):
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(b"fake-xlsx")
        return 5, 2

    def fake_upload(local_path, remote_dir=None, remote_name=None,
                    lock_owner=None):
        name = remote_name or os.path.basename(local_path)
        uploaded.append((local_path, remote_dir, name, lock_owner))
        return f"{remote_dir.replace('/', os.sep)}\\{name}"

    monkeypatch.setattr(
        data_routes, "generate_filtered_excel_from_table", fake_filtered)
    monkeypatch.setattr(data_routes, "upload_file_to_windows", fake_upload)

    target = User(username="user2", display_name="user2",
                  dept_id=test_scope.id, role="user", is_active=True)
    db_session.add(target)
    db_session.commit()
    db_session.refresh(target)

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
    })
    assert resp.status_code == 200, resp.text

    _local, remote_dir, name, lock_owner = uploaded[-1]
    assert name == "subset.xlsx"
    assert remote_dir == f"{settings.windows_workspace_dir}/user2"
    assert lock_owner == "user2"
