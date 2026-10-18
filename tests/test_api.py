"""FastAPI API 集成测试 — 端到端接口测试"""
import os
import csv
import tempfile

import pytest

from app.models import User, Scope, PendingFile, ExportResult, AuditLog, Session as SessionModel
from app.config import settings


# ============================================================
# 测试：健康检查 & 根路径
# ============================================================

class TestHealthCheck:
    """基础服务可用性测试"""

    def test_health(self, client):
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}

    def test_root(self, client):
        """根路径返回 Vue SPA 入口页（前端 history 路由入口）"""
        resp = client.get("/")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]
        assert '<div id="app">' in resp.text


# ============================================================
# 测试：认证路由 /auth
# ============================================================

class TestAuthLogin:
    """POST /auth/login 测试"""

    def test_login_success_admin(self, client, test_admin):
        """管理员登录成功"""
        resp = client.post("/auth/login", json={
            "username": "admin",
            "password": "admin123",
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["token_type"] == "bearer"
        assert len(data["access_token"]) > 20

    def test_login_success_user(self, client, test_user):
        """普通用户登录成功"""
        resp = client.post("/auth/login", json={
            "username": "user1",
            "password": "user123",
        })
        assert resp.status_code == 200

    def test_login_wrong_password(self, client, test_user):
        """密码错误返回 401"""
        resp = client.post("/auth/login", json={
            "username": "user1",
            "password": "wrong",
        })
        assert resp.status_code == 401
        assert "错误" in resp.json()["detail"]

    def test_login_nonexistent_user(self, client):
        """不存在的用户返回 401"""
        resp = client.post("/auth/login", json={
            "username": "nobody",
            "password": "any",
        })
        assert resp.status_code == 401

    def test_login_missing_fields(self, client):
        """缺少字段返回 422"""
        resp = client.post("/auth/login", json={"username": "admin"})
        assert resp.status_code == 422


class TestGetMe:
    """GET /me 测试"""

    def test_get_me_success(self, client, test_user, auth_headers):
        """获取当前用户信息"""
        resp = client.get("/auth/me", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["username"] == "user1"
        assert data["role"] == "user"
        assert data["display_name"] == "测试用户1"

    def test_get_me_without_token(self, client):
        """无 Token 返回 401"""
        resp = client.get("/auth/me")
        assert resp.status_code == 401

    def test_get_me_with_invalid_token(self, client):
        """无效 Token 返回 401"""
        resp = client.get("/auth/me", headers={"Authorization": "Bearer invalid_token"})
        assert resp.status_code == 401

    def test_get_me_includes_dept(self, client, test_user, test_scope, auth_headers):
        """用户信息包含部门"""
        resp = client.get("/auth/me", headers=auth_headers)
        data = resp.json()
        assert data["dept"] is not None
        assert data["dept"]["scope_code"] == "dept_1"


# ============================================================
# 测试：会话路由 /session
# ============================================================

class TestSessionConnect:
    """POST /session/connect 测试"""

    @staticmethod
    def _enable_sync(monkeypatch):
        """模拟已启用 Guacamole JDBC 同步（专属连接 id=42）"""
        monkeypatch.setattr("app.routers.session.guac_sync_enabled", lambda: True)
        monkeypatch.setattr("app.routers.session.get_user_connection_id", lambda u: 42)
        monkeypatch.setattr("app.routers.session.ensure_user_connection", lambda u: 42)

    def test_connect(self, client, test_user, auth_headers, monkeypatch):
        """连接 Windows 分析平台（同步已启用 → 专属连接）"""
        self._enable_sync(monkeypatch)
        resp = client.post("/session/connect", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["software"] == "windows"
        assert data["status"] == "active"
        assert "guac_url" in data
        assert data["guac_url"].endswith("42")

    def test_connect_rejected_when_sync_disabled(self, client, test_user, auth_headers):
        """安全修复 A4：未启用 JDBC 同步时拒绝共享连接，返回 503"""
        resp = client.post("/session/connect", headers=auth_headers)
        assert resp.status_code == 503
        assert "GUAC_DB_URL" in resp.json()["detail"]

    def test_connect_provisions_workspace(self, client, test_user, auth_headers, monkeypatch):
        """连接时幂等补建私有工作区（老账号补偿）"""
        self._enable_sync(monkeypatch)
        monkeypatch.setattr("app.routers.session.windows_sync_enabled", lambda: True)
        calls = []
        monkeypatch.setattr(
            "app.routers.session.provision_user_workspace",
            lambda u, **kw: calls.append(u) or True,
        )
        resp = client.post("/session/connect", headers=auth_headers)
        assert resp.status_code == 200
        assert calls == [test_user.username]

    def test_connect_provision_failure_not_blocking(self, client, test_user, auth_headers, monkeypatch):
        """工作区开通失败只记日志，不阻断远程连接"""
        self._enable_sync(monkeypatch)
        monkeypatch.setattr("app.routers.session.windows_sync_enabled", lambda: True)

        def boom(u, **kw):
            raise RuntimeError("ssh down")

        monkeypatch.setattr("app.routers.session.provision_user_workspace", boom)
        resp = client.post("/session/connect", headers=auth_headers)
        assert resp.status_code == 200
        assert "guac_url" in resp.json()

    def test_connect_without_auth(self, client):
        """未认证返回 401"""
        resp = client.post("/session/connect")
        assert resp.status_code == 401

    def test_connect_creates_audit_log(self, client, test_user, auth_headers, db_session, monkeypatch):
        """连接创建审计日志"""
        self._enable_sync(monkeypatch)
        client.post("/session/connect", headers=auth_headers)
        logs = db_session.query(AuditLog).filter(
            AuditLog.action == "session_connect"
        ).all()
        assert len(logs) >= 1

    def test_connect_creates_session_record(self, client, test_user, auth_headers, db_session, monkeypatch):
        """连接创建数据库会话记录"""
        self._enable_sync(monkeypatch)
        resp = client.post("/session/connect", headers=auth_headers)
        session_id = resp.json()["id"]
        record = db_session.query(SessionModel).filter(SessionModel.id == session_id).first()
        assert record is not None
        assert record.software == "windows"


# ============================================================
# 测试：结果路由 /results
# ============================================================

class TestResultsMine:
    """GET /results/mine 测试"""

    def test_empty_results(self, client, test_user, auth_headers):
        """无结果时返回空列表"""
        resp = client.get("/results/mine", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["pending"] == []
        assert data["published"] == []

    def test_results_without_auth(self, client):
        """未认证返回 401"""
        resp = client.get("/results/mine")
        assert resp.status_code == 401

    def test_results_only_own(self, client, db_session, test_user, auth_headers):
        """只返回自己的结果"""
        # 创建另一个用户的结果
        other = User(username="other", dept_id=test_user.dept_id, role="user", is_active=True)
        db_session.add(other)
        db_session.commit()
        db_session.refresh(other)

        pf = PendingFile(
            user_id=other.id, file_name="other_result.csv",
            file_path="/tmp/other.csv", file_type="csv", status="pending",
        )
        db_session.add(pf)
        db_session.commit()

        resp = client.get("/results/mine", headers=auth_headers)
        data = resp.json()
        assert data["pending"] == []


class TestResultsRequestExport:
    """POST /results/request-export 测试"""

    def test_request_empty_dir(self, client, test_user, auth_headers, pending_dir):
        """空 pending 目录"""
        resp = client.post("/results/request-export", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["registered"] == 0

    def test_request_registers_pending(self, client, test_user, auth_headers, pending_dir, db_session):
        """登记待审核文件，状态为 pending"""
        csv_path = os.path.join(pending_dir, "result.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")

        resp = client.post("/results/request-export", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["registered"] == 1

        records = db_session.query(PendingFile).filter(
            PendingFile.user_id == test_user.id
        ).all()
        assert len(records) == 1
        assert records[0].file_name == "result.csv"
        assert records[0].status == "pending"

    def test_request_creates_audit_log(self, client, test_user, auth_headers, pending_dir, db_session):
        """申请导出创建审计日志"""
        csv_path = os.path.join(pending_dir, "audit.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")

        client.post("/results/request-export", headers=auth_headers)
        logs = db_session.query(AuditLog).filter(AuditLog.action == "export_requested").all()
        assert len(logs) >= 1

    def test_request_skips_already_registered(self, client, test_user, auth_headers, pending_dir):
        """已登记的文件不重复申请"""
        csv_path = os.path.join(pending_dir, "dup.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")

        client.post("/results/request-export", headers=auth_headers)
        resp = client.post("/results/request-export", headers=auth_headers)
        assert resp.json()["registered"] == 0

    def test_request_without_auth(self, client):
        """未认证返回 401"""
        resp = client.post("/results/request-export")
        assert resp.status_code == 401


class TestAdminExportReview:
    """管理员审核导出申请测试"""

    def _submit(self, client, auth_headers, pending_dir, name="result.csv"):
        """用户提交一个导出申请，返回 pending 记录 id"""
        csv_path = os.path.join(pending_dir, name)
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean,std\n1.0,2.0\n")
        client.post("/results/request-export", headers=auth_headers)
        resp = client.get("/results/mine", headers=auth_headers)
        return resp.json()["pending"][0]["id"]

    def test_approve(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir, db_session):
        """审核通过创建导出结果"""
        pid = self._submit(client, auth_headers, pending_dir)

        resp = client.post(f"/admin/pending/{pid}/approve", headers=admin_headers, json={"reason": "通过"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "approved"

        exports = db_session.query(ExportResult).filter(ExportResult.user_id == test_user.id).all()
        assert len(exports) == 1
        assert os.path.exists(exports[0].file_path)

    def test_reject(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir, db_session):
        """审核拒绝，不创建导出结果"""
        pid = self._submit(client, auth_headers, pending_dir)

        resp = client.post(f"/admin/pending/{pid}/reject", headers=admin_headers, json={"reason": "含敏感数据"})
        assert resp.status_code == 200
        assert resp.json()["status"] == "rejected"

        exports = db_session.query(ExportResult).filter(ExportResult.user_id == test_user.id).all()
        assert len(exports) == 0

    def test_approve_requires_admin(self, client, test_user, auth_headers, pending_dir):
        """普通用户不能审批"""
        pid = self._submit(client, auth_headers, pending_dir)
        resp = client.post(f"/admin/pending/{pid}/approve", headers=auth_headers, json={})
        assert resp.status_code == 403

    def test_approve_nonexistent(self, client, test_admin, admin_headers):
        """审批不存在的申请返回 404"""
        resp = client.post("/admin/pending/9999/approve", headers=admin_headers, json={})
        assert resp.status_code == 404

    def test_pending_list_only_pending(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir):
        """管理员 pending 列表只含待审核项"""
        pid = self._submit(client, auth_headers, pending_dir)
        # 通过后不应再出现在待审核列表
        client.post(f"/admin/pending/{pid}/approve", headers=admin_headers, json={})
        resp = client.get("/admin/pending", headers=admin_headers)
        assert resp.status_code == 200
        assert all(p["status"] == "pending" for p in resp.json())


class TestResultsDownload:
    """POST /results/{id}/download 测试"""

    def _approved_result_id(self, client, auth_headers, admin_headers, pending_dir):
        """提交申请并经管理员审核通过，返回可下载的结果 id"""
        csv_path = os.path.join(pending_dir, "downloadable.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")
        client.post("/results/request-export", headers=auth_headers)
        pid = client.get("/results/mine", headers=auth_headers).json()["pending"][0]["id"]
        client.post(f"/admin/pending/{pid}/approve", headers=admin_headers, json={})
        return client.get("/results/mine", headers=auth_headers).json()["published"][0]["id"]

    def test_download_success(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir):
        """下载已发布结果"""
        result_id = self._approved_result_id(client, auth_headers, admin_headers, pending_dir)
        dl_resp = client.post(f"/results/{result_id}/download", headers=auth_headers)
        assert dl_resp.status_code == 200
        assert dl_resp.headers["content-type"] == "application/octet-stream"

    def test_download_nonexistent(self, client, test_user, auth_headers):
        """下载不存在的结果返回 404"""
        resp = client.post("/results/9999/download", headers=auth_headers)
        assert resp.status_code == 404

    def test_download_increases_count(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir, db_session):
        """下载次数递增"""
        result_id = self._approved_result_id(client, auth_headers, admin_headers, pending_dir)
        client.post(f"/results/{result_id}/download", headers=auth_headers)
        client.post(f"/results/{result_id}/download", headers=auth_headers)

        exp = db_session.query(ExportResult).filter(ExportResult.id == result_id).first()
        assert exp.download_count == 2

    def test_download_creates_audit_log(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir, db_session):
        """下载创建审计日志"""
        result_id = self._approved_result_id(client, auth_headers, admin_headers, pending_dir)
        client.post(f"/results/{result_id}/download", headers=auth_headers)

        logs = db_session.query(AuditLog).filter(AuditLog.action == "result_download").all()
        assert len(logs) >= 1


# ============================================================
# 测试：管理员路由 /admin
# ============================================================

class TestAdminAudit:
    """GET /admin/audit 测试"""

    def test_admin_can_access(self, client, test_admin, admin_headers):
        """管理员可以访问审计日志"""
        resp = client.get("/admin/audit", headers=admin_headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_user_cannot_access(self, client, test_user, user_token):
        """普通用户不能访问审计日志"""
        resp = client.get("/admin/audit", headers={"Authorization": f"Bearer {user_token}"})
        assert resp.status_code == 403
        assert "管理员" in resp.json()["detail"]

    def test_admin_audit_without_auth(self, client):
        """未认证返回 401"""
        resp = client.get("/admin/audit")
        assert resp.status_code == 401

    def test_admin_audit_filter_by_action(self, client, test_admin, admin_headers, db_session):
        """按 action 过滤审计日志"""
        # 创建一些日志
        db_session.add(AuditLog(user_id=test_admin.id, action="login", detail="test"))
        db_session.add(AuditLog(user_id=test_admin.id, action="session_launch", detail="test"))
        db_session.commit()

        resp = client.get("/admin/audit?action=login", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        for log in data:
            assert log["action"] == "login"

    def test_admin_audit_pagination(self, client, test_admin, admin_headers, db_session):
        """审计日志分页"""
        for i in range(10):
            db_session.add(AuditLog(user_id=test_admin.id, action="test", detail=f"item-{i}"))
        db_session.commit()

        resp = client.get("/admin/audit?skip=5&limit=3", headers=admin_headers)
        data = resp.json()
        assert len(data) == 3


class TestAdminPending:
    """GET /admin/pending 测试"""

    def test_admin_can_list_pending(self, client, test_admin, admin_headers):
        """管理员可以查看所有待审查文件"""
        resp = client.get("/admin/pending", headers=admin_headers)
        assert resp.status_code == 200
        assert isinstance(resp.json(), list)

    def test_user_cannot_list_pending(self, client, test_user, user_token):
        """普通用户不能查看所有待审查"""
        resp = client.get("/admin/pending", headers={"Authorization": f"Bearer {user_token}"})
        assert resp.status_code == 403


# ============================================================
# 测试：完整业务流程（端到端）
# ============================================================

class TestEndToEnd:
    """端到端完整流程测试"""

    def test_full_workflow(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir, published_dir, db_session, monkeypatch):
        """完整流程：连接 → 申请导出 → 管理员审核通过 → 下载"""
        # 模拟已启用 Guacamole JDBC 同步（安全修复 A4 后连接需专属连接）
        TestSessionConnect._enable_sync(monkeypatch)

        # 1. 验证身份
        resp = client.get("/auth/me", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["username"] == "user1"

        # 2. 连接 Windows 分析平台
        resp = client.post("/session/connect", headers=auth_headers)
        assert resp.status_code == 200
        assert "guac_url" in resp.json()

        # 3. 模拟用户保存结果到 pending 目录
        csv_path = os.path.join(pending_dir, "final_results.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["term", "estimate", "std_err", "p_value"])
            writer.writerow(["x1", "0.85", "0.05", "0.001"])
            writer.writerow(["x2", "-0.3", "0.1", "0.005"])

        # 4. 申请导出
        resp = client.post("/results/request-export", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["registered"] == 1

        # 5. 管理员审核通过
        pending = client.get("/results/mine", headers=auth_headers).json()["pending"]
        pid = pending[0]["id"]
        resp = client.post(f"/admin/pending/{pid}/approve", headers=admin_headers, json={"reason": "通过"})
        assert resp.status_code == 200

        # 6. 查看我的结果（已发布）
        resp = client.get("/results/mine", headers=auth_headers)
        data = resp.json()
        assert len(data["published"]) == 1
        assert data["published"][0]["result_name"] == "final_results.csv"
        result_id = data["published"][0]["id"]

        # 7. 下载结果
        resp = client.post(f"/results/{result_id}/download", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/octet-stream"

        # 8. 验证审计日志记录了整个流程
        logs = db_session.query(AuditLog).all()
        actions = [log.action for log in logs]
        assert "session_connect" in actions
        assert "export_requested" in actions
        assert "export_approved" in actions
        assert "result_download" in actions

    def test_rejected_workflow(self, client, test_user, test_admin, auth_headers, admin_headers, pending_dir, db_session):
        """被拒绝的流程：申请导出被管理员拒绝"""

        # 模拟用户保存结果文件
        csv_path = os.path.join(pending_dir, "sensitive.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["mean", "note"])
            writer.writerow(["1.0", "电话13812345678"])

        # 申请导出
        client.post("/results/request-export", headers=auth_headers)
        pid = client.get("/results/mine", headers=auth_headers).json()["pending"][0]["id"]

        # 管理员拒绝
        resp = client.post(f"/admin/pending/{pid}/reject", headers=admin_headers, json={"reason": "含敏感数据"})
        assert resp.status_code == 200

        # 验证无已发布结果
        resp = client.get("/results/mine", headers=auth_headers)
        data = resp.json()
        assert data["published"] == []

        # 验证审计日志记录了拒绝
        logs = db_session.query(AuditLog).filter(
            AuditLog.action == "export_rejected"
        ).all()
        assert len(logs) >= 1


# ============================================================
# 测试：管理员数据权限分配
# ============================================================

class TestAdminUsers:
    """GET /admin/users 测试"""

    def test_admin_can_list_users(self, client, test_admin, test_user, admin_headers):
        """管理员可查看所有用户"""
        resp = client.get("/admin/users", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        usernames = [u["username"] for u in data]
        assert "admin" in usernames
        assert "user1" in usernames

    def test_user_cannot_list_users(self, client, test_user, user_token):
        """普通用户不能查看所有用户"""
        resp = client.get("/admin/users", headers={"Authorization": f"Bearer {user_token}"})
        assert resp.status_code == 403

    def test_users_without_auth(self, client):
        """未认证返回 401"""
        resp = client.get("/admin/users")
        assert resp.status_code == 401


class TestAdminScopes:
    """GET /admin/scopes 测试"""

    def test_admin_can_list_scopes(self, client, test_admin, test_scope, admin_headers):
        """管理员可查看所有数据范围"""
        resp = client.get("/admin/scopes", headers=admin_headers)
        assert resp.status_code == 200
        data = resp.json()
        codes = [s["scope_code"] for s in data]
        assert "dept_1" in codes

    def test_user_cannot_list_scopes(self, client, test_user, user_token):
        """普通用户不能查看数据范围"""
        resp = client.get("/admin/scopes", headers={"Authorization": f"Bearer {user_token}"})
        assert resp.status_code == 403


class TestAdminAssignScopes:
    """PUT /admin/users/{id}/scopes 测试"""

    def _create_project(self, db_session, code="proj_1", name="测试项目"):
        scope = Scope(
            scope_code=code,
            scope_type="project",
            scope_name=name,
            data_path=os.path.join(settings.fileserver_root, "data", code),
        )
        db_session.add(scope)
        db_session.commit()
        db_session.refresh(scope)
        return scope

    def test_assign_dept_and_scopes(self, client, test_admin, test_user, test_scope, admin_headers, db_session):
        """分配部门 + 项目范围成功"""
        proj = self._create_project(db_session)
        resp = client.put(
            f"/admin/users/{test_user.id}/scopes",
            json={"dept_id": test_scope.id, "scope_ids": [proj.id]},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["dept_id"] == test_scope.id
        assert [s["id"] for s in data["scopes"]] == [proj.id]

    def test_assign_clear_all(self, client, test_admin, test_user, admin_headers, db_session):
        """清空权限（dept_id=null, scope_ids=[]）"""
        resp = client.put(
            f"/admin/users/{test_user.id}/scopes",
            json={"dept_id": None, "scope_ids": []},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["dept_id"] is None
        assert data["scopes"] == []

    def test_assign_nonexistent_user(self, client, test_admin, admin_headers):
        """分配不存在的用户返回 404"""
        resp = client.put(
            "/admin/users/99999/scopes",
            json={"dept_id": None, "scope_ids": []},
            headers=admin_headers,
        )
        assert resp.status_code == 404

    def test_assign_invalid_dept(self, client, test_admin, test_user, admin_headers):
        """分配无效部门 ID 返回 400"""
        resp = client.put(
            f"/admin/users/{test_user.id}/scopes",
            json={"dept_id": 99999, "scope_ids": []},
            headers=admin_headers,
        )
        assert resp.status_code == 400

    def test_assign_invalid_project_scope(self, client, test_admin, test_user, admin_headers):
        """分配无效项目范围 ID 返回 400"""
        resp = client.put(
            f"/admin/users/{test_user.id}/scopes",
            json={"dept_id": None, "scope_ids": [99999]},
            headers=admin_headers,
        )
        assert resp.status_code == 400

    def test_assign_creates_audit_log(self, client, test_admin, test_user, admin_headers, db_session):
        """分配操作写入审计日志"""
        resp = client.put(
            f"/admin/users/{test_user.id}/scopes",
            json={"dept_id": None, "scope_ids": []},
            headers=admin_headers,
        )
        assert resp.status_code == 200
        logs = db_session.query(AuditLog).filter(
            AuditLog.action == "assign_scopes"
        ).all()
        assert len(logs) >= 1

    def test_user_cannot_assign(self, client, test_user, user_token):
        """普通用户不能分配权限"""
        resp = client.put(
            f"/admin/users/{test_user.id}/scopes",
            json={"dept_id": None, "scope_ids": []},
            headers={"Authorization": f"Bearer {user_token}"},
        )
        assert resp.status_code == 403

    def test_assign_without_auth(self, client, test_user):
        """未认证返回 401"""
        resp = client.put(
            f"/admin/users/{test_user.id}/scopes",
            json={"dept_id": None, "scope_ids": []},
        )
        assert resp.status_code == 401
