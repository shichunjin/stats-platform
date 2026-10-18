"""数据投递通道回归测试（安全修复 A1 后）。

修复内容：
- /data/fetch 已停用：任何登录用户直接拉取全量宽表都返回 403，
  取数统一走「申请 → 管理员按筛选生成」流程；
- /data/generate 必须绑定有效数据申请：apply_id 必填、申请必须属于目标用户、
  状态必须为 pending/processing/failed，并使用行锁防止并发重复生成；
- 性能修复 C1：生成已异步化——接口认领（置 generating）后立即返回，
  后台线程执行 Excel 生成 + SFTP 推送，失败置 failed 并可重试；
- 生成投递仍必须进入目标用户私有工作区（W: 盘）并以目标用户身份锁定。
"""
import os

import pytest

import app.jobs as jobs
import app.routers.data as data_routes
from app.auth import create_access_token
from app.config import settings
from app.models import User, DataApply


@pytest.fixture(autouse=True)
def _inline_jobs(monkeypatch, db_session):
    """性能修复 C1：生成已异步化。测试内联执行后台任务，
    并注入用例同一会话（保持 SAVEPOINT 隔离，不跨连接）。"""
    def _inline(apply_id, fn, **kwargs):
        fn(session=db_session, **kwargs)
        return True

    monkeypatch.setattr(jobs, "submit_generate", _inline)


def _make_user(db_session, scope, username: str, role: str = "user", with_scope: bool = True):
    user = User(username=username, display_name=username, dept_id=scope.id,
                role=role, is_active=True)
    # B7 修复后，无 scopes 的用户会被拒绝生成；默认赋予测试范围，
    # 需验证门禁的用例传 with_scope=False
    if with_scope:
        user.scopes = [scope]
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    token = create_access_token(user.id, user.username, role)
    return user, {"Authorization": f"Bearer {token}"}


def _patch_upload(monkeypatch, uploaded: list):
    """替换真实 SFTP 上传，记录投递目标。"""

    def fake_upload(local_path, remote_dir=None, remote_name=None,
                    lock_owner=None):
        name = remote_name or os.path.basename(local_path)
        uploaded.append((local_path, remote_dir, name, lock_owner))
        return f"{remote_dir.replace('/', os.sep)}\\{name}"

    monkeypatch.setattr(data_routes, "upload_file_to_windows", fake_upload)


def _patch_filtered_generator(monkeypatch):
    def fake_filtered(db, table_name, out_path, filters):
        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        with open(out_path, "wb") as f:
            f.write(b"fake-xlsx")
        return 5, 2

    monkeypatch.setattr(
        data_routes, "generate_filtered_excel_from_table", fake_filtered)


# ---- /data/fetch 已停用（A1） ----

def test_fetch_rejected_for_normal_user(client, auth_headers):
    """任意登录用户直接拉取全量宽表必须 403"""
    resp = client.post("/data/fetch", headers=auth_headers)
    assert resp.status_code == 403
    assert "申请" in resp.json()["detail"]


def test_fetch_rejected_for_admin(client, admin_headers):
    """管理员也不得绕过申请流程直拉全量"""
    assert client.post("/data/fetch", headers=admin_headers).status_code == 403


# ---- /data/generate 必须绑定有效申请（A1/B6） ----

def _create_apply(db_session, user_id: int, status: str = "pending") -> DataApply:
    apply_obj = DataApply(user_id=user_id, purpose="回归测试", status=status)
    db_session.add(apply_obj)
    db_session.commit()
    db_session.refresh(apply_obj)
    return apply_obj


def test_generate_requires_apply_id(client, admin_headers, db_session,
                                    test_scope, monkeypatch):
    _patch_filtered_generator(monkeypatch)
    target, _ = _make_user(db_session, test_scope, "gen_user")

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
    })
    assert resp.status_code == 400
    assert "申请" in resp.json()["detail"]


def test_generate_rejects_apply_of_other_user(client, admin_headers, db_session,
                                              test_scope, monkeypatch):
    """申请必须属于目标用户，不能拿他人申请冒名生成"""
    _patch_filtered_generator(monkeypatch)
    target, _ = _make_user(db_session, test_scope, "gen_target")
    other, _ = _make_user(db_session, test_scope, "gen_other")
    apply_obj = _create_apply(db_session, other.id)

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 400


def test_generate_rejects_finished_apply(client, admin_headers, db_session,
                                         test_scope, monkeypatch):
    """已完成的申请不可重复生成"""
    _patch_filtered_generator(monkeypatch)
    target, _ = _make_user(db_session, test_scope, "gen_done")
    apply_obj = _create_apply(db_session, target.id, status="completed")

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 400


def test_generate_with_valid_apply_completes_and_delivers(
        client, admin_headers, db_session, test_scope, monkeypatch):
    """有效申请：生成成功 → 申请置为 completed → 投递到目标用户私有目录并锁定"""
    uploaded = []
    _patch_filtered_generator(monkeypatch)
    _patch_upload(monkeypatch, uploaded)
    target, _ = _make_user(db_session, test_scope, "gen_ok")
    apply_obj = _create_apply(db_session, target.id, status="pending")

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 200, resp.text

    # 申请状态机推进
    db_session.refresh(apply_obj)
    assert apply_obj.status == "completed"
    assert apply_obj.processed_by is not None
    assert apply_obj.finished_at is not None

    # 投递目标与锁定身份必须是目标用户本人
    _local, remote_dir, name, lock_owner = uploaded[-1]
    assert name == "subset.xlsx"
    assert remote_dir == f"{settings.windows_workspace_dir}/gen_ok"
    assert lock_owner == "gen_ok"


def test_generate_rejects_rejected_apply(client, admin_headers, db_session,
                                         test_scope, monkeypatch):
    """被拒绝的申请不可生成"""
    _patch_filtered_generator(monkeypatch)
    target, _ = _make_user(db_session, test_scope, "gen_rej")
    apply_obj = _create_apply(db_session, target.id, status="rejected")

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 400


# ---- scopes 权限消费（B7） ----

def test_generate_rejects_scopeless_user(client, admin_headers, db_session,
                                         test_scope, monkeypatch):
    """安全修复 B7：目标用户未分配 scopes 时拒绝生成（无 scope 拒绝取数）"""
    _patch_filtered_generator(monkeypatch)
    target, _ = _make_user(db_session, test_scope, "gen_noscope", with_scope=False)
    apply_obj = _create_apply(db_session, target.id, status="pending")

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 400
    assert "权限" in resp.json()["detail"]

    # 申请状态不得被推进
    db_session.refresh(apply_obj)
    assert apply_obj.status == "pending"


# ---- 生成异步化（C1） ----

def test_generate_async_submission_marks_generating(client, admin_headers, db_session,
                                                    test_scope, monkeypatch):
    """C1：接口认领后立即返回，申请进入 generating（后台任务不阻塞请求线程）"""
    _patch_filtered_generator(monkeypatch)
    target, _ = _make_user(db_session, test_scope, "gen_async")
    apply_obj = _create_apply(db_session, target.id, status="pending")

    # 覆盖 autouse 内联执行器：只接收任务不执行，验证「提交即返回」语义
    monkeypatch.setattr(jobs, "submit_generate", lambda apply_id, fn, **kw: True)

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "generating"
    assert resp.json()["apply_id"] == apply_obj.id

    db_session.refresh(apply_obj)
    assert apply_obj.status == "generating"
    assert apply_obj.processed_by is not None


def test_generate_failure_marks_failed_and_retryable(client, admin_headers, db_session,
                                                     test_scope, monkeypatch):
    """C1：后台生成失败 → 申请置 failed 并记录原因；管理员可从 failed 重试成功"""
    target, _ = _make_user(db_session, test_scope, "gen_fail")
    apply_obj = _create_apply(db_session, target.id, status="pending")

    def boom(db, table_name, out_path, filters):
        raise RuntimeError("磁盘满")

    monkeypatch.setattr(data_routes, "generate_filtered_excel_from_table", boom)
    uploaded = []
    _patch_upload(monkeypatch, uploaded)

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 200, resp.text  # 受理成功（异步执行）

    db_session.refresh(apply_obj)
    assert apply_obj.status == "failed"
    assert "磁盘满" in (apply_obj.reject_reason or "")
    assert uploaded == []  # 失败发生在生成阶段，未触达 SFTP

    # 故障修复后从 failed 重新生成（重试）
    _patch_filtered_generator(monkeypatch)
    resp2 = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp2.status_code == 200, resp2.text
    db_session.refresh(apply_obj)
    assert apply_obj.status == "completed"
    assert uploaded[-1][2] == "subset.xlsx"


def test_generate_inflight_conflict_409(client, admin_headers, db_session,
                                        test_scope, monkeypatch):
    """C1：同一申请已有任务在跑时，重复提交返回 409（防双击/重试风暴）"""
    _patch_filtered_generator(monkeypatch)
    target, _ = _make_user(db_session, test_scope, "gen_dup")
    apply_obj = _create_apply(db_session, target.id, status="pending")

    # 模拟执行器拒绝（任务在跑）
    monkeypatch.setattr(jobs, "submit_generate", lambda apply_id, fn, **kw: False)

    resp = client.post("/data/generate", headers=admin_headers, json={
        "target_user_id": target.id,
        "filters": {"sex33": 1},
        "filename": "subset.xlsx",
        "apply_id": apply_obj.id,
    })
    assert resp.status_code == 409
