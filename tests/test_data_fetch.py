"""「获取数据」/data/fetch 文件命名回归测试。

历史缺陷：该接口把输出写死为 {DATASET_NAME}.xlsx，每次获取都覆盖
本地 fileserver_root/data/ 与 Windows Z: 盘上的同名文件，历史数据丢失。
修复后要求：时间戳命名、每次独立、SFTP 远端沿用同一文件名。
"""
import os
import re

import app.routers.data as data_routes
from app.config import settings

TS_NAME = re.compile(r"^testData_\d{8}_\d{6}\.xlsx$")


def _patch_generators(monkeypatch, uploaded: list):
    """替换真实 Excel 生成与 SFTP 上传：生成器落一个真实占位文件。"""

    def fake_generate(db, table_name, out_path, *args, **kwargs):
        with open(out_path, "wb") as f:
            f.write(b"fake-xlsx")
        return 10, 3

    def fake_upload(local_path, remote_dir=None, remote_name=None):
        name = remote_name or os.path.basename(local_path)
        uploaded.append((local_path, remote_dir, name))
        return f"C:\\StatsData\\{name}"

    monkeypatch.setattr(data_routes, "generate_excel_from_table", fake_generate)
    monkeypatch.setattr(data_routes, "upload_file_to_windows", fake_upload)


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
