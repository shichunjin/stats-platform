"""FastAPI API 集成测试 — 端到端接口测试"""
import os
import csv
import tempfile
from unittest.mock import patch, MagicMock

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
        resp = client.get("/")
        assert resp.status_code == 200
        data = resp.json()
        assert data["service"] == "统计软件托管平台"
        assert "docs" in data
        assert "endpoints" in data


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

class TestSessionLaunch:
    """POST /session/launch/{software} 测试"""

    @patch("app.routers.session.subprocess.Popen")
    def test_launch_rstudio(self, mock_popen, client, test_user, auth_headers):
        """启动 RStudio 会话"""
        mock_popen.return_value = MagicMock()
        resp = client.post("/session/launch/rstudio", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["software"] == "rstudio"
        assert data["status"] == "active"
        assert "guac_url" in data
        assert "rstudio" in data["guac_url"]

    @patch("app.routers.session.subprocess.Popen")
    def test_launch_mplus(self, mock_popen, client, test_user, auth_headers):
        """启动 Mplus 会话"""
        mock_popen.return_value = MagicMock()
        resp = client.post("/session/launch/mplus", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["software"] == "mplus"

    @patch("app.routers.session.subprocess.Popen")
    def test_launch_stata(self, mock_popen, client, test_user, auth_headers):
        """启动 Stata 会话"""
        mock_popen.return_value = MagicMock()
        resp = client.post("/session/launch/stata", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["software"] == "stata"

    @patch("app.routers.session.subprocess.Popen")
    def test_launch_invalid_software(self, mock_popen, client, test_user, auth_headers):
        """不支持的软件返回 400"""
        resp = client.post("/session/launch/spss", headers=auth_headers)
        assert resp.status_code == 400
        assert "不支持的软件" in resp.json()["detail"]

    @patch("app.routers.session.subprocess.Popen")
    def test_launch_without_auth(self, mock_popen, client):
        """未认证返回 401"""
        resp = client.post("/session/launch/rstudio")
        assert resp.status_code == 401

    @patch("app.routers.session.subprocess.Popen")
    def test_launch_creates_audit_log(self, mock_popen, client, test_user, auth_headers, db_session):
        """启动会话创建审计日志"""
        mock_popen.return_value = MagicMock()
        client.post("/session/launch/rstudio", headers=auth_headers)
        logs = db_session.query(AuditLog).filter(
            AuditLog.action == "session_launch"
        ).all()
        assert len(logs) >= 1
        assert "rstudio" in logs[0].detail

    @patch("app.routers.session.subprocess.Popen")
    def test_launch_creates_session_record(self, mock_popen, client, test_user, auth_headers, db_session):
        """启动会话创建数据库会话记录"""
        mock_popen.return_value = MagicMock()
        resp = client.post("/session/launch/rstudio", headers=auth_headers)
        session_id = resp.json()["id"]
        record = db_session.query(SessionModel).filter(SessionModel.id == session_id).first()
        assert record is not None
        assert record.software == "rstudio"


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


class TestResultsScan:
    """POST /results/scan 测试"""

    def test_scan_empty_dir(self, client, test_user, auth_headers, pending_dir):
        """空 pending 目录"""
        resp = client.post("/results/scan", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["scanned"] == 0
        assert data["results"] == []

    def test_scan_approved_csv(self, client, test_user, auth_headers, pending_dir, published_dir):
        """扫描通过的 CSV 文件"""
        csv_path = os.path.join(pending_dir, "summary.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["variable", "mean", "std", "n"])
            writer.writerow(["age", "35.2", "10.1", "100"])

        resp = client.post("/results/scan", headers=auth_headers)
        assert resp.status_code == 200
        data = resp.json()
        assert data["scanned"] == 1
        assert data["results"][0]["status"] == "approved"

    def test_scan_rejected_csv_sensitive(self, client, test_user, auth_headers, pending_dir):
        """扫描含敏感字段的 CSV"""
        csv_path = os.path.join(pending_dir, "bad.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["name", "phone"])
            writer.writerow(["张三", "13812345678"])

        resp = client.post("/results/scan", headers=auth_headers)
        data = resp.json()
        assert data["scanned"] == 1
        assert data["results"][0]["status"] == "rejected"

    def test_scan_rejected_csv_too_many_rows(self, client, test_user, auth_headers, pending_dir):
        """扫描行数超限的 CSV"""
        csv_path = os.path.join(pending_dir, "large.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["mean", "std"])
            for _ in range(250):
                writer.writerow(["1.0", "2.0"])

        resp = client.post("/results/scan", headers=auth_headers)
        data = resp.json()
        assert data["results"][0]["status"] == "rejected"

    def test_scan_creates_pending_file_record(self, client, test_user, auth_headers, pending_dir, db_session):
        """扫描后创建 pending_files 记录"""
        csv_path = os.path.join(pending_dir, "result.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["mean", "std"])
            writer.writerow(["1.0", "2.0"])

        client.post("/results/scan", headers=auth_headers)
        records = db_session.query(PendingFile).filter(
            PendingFile.user_id == test_user.id
        ).all()
        assert len(records) == 1
        assert records[0].file_name == "result.csv"

    def test_scan_approved_creates_export_result(self, client, test_user, auth_headers, pending_dir, published_dir, db_session):
        """审查通过后创建 export_results 记录"""
        csv_path = os.path.join(pending_dir, "good.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["mean", "std"])
            writer.writerow(["1.0", "2.0"])

        client.post("/results/scan", headers=auth_headers)
        exports = db_session.query(ExportResult).filter(
            ExportResult.user_id == test_user.id
        ).all()
        assert len(exports) == 1
        assert exports[0].result_name == "good.csv"
        assert os.path.exists(exports[0].file_path)

    def test_scan_creates_audit_log(self, client, test_user, auth_headers, pending_dir, db_session):
        """扫描创建审计日志"""
        csv_path = os.path.join(pending_dir, "audit_test.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["mean", "std"])
            writer.writerow(["1.0", "2.0"])

        client.post("/results/scan", headers=auth_headers)
        logs = db_session.query(AuditLog).filter(
            AuditLog.action == "result_approved"
        ).all()
        assert len(logs) >= 1

    def test_scan_skips_already_pending(self, client, test_user, auth_headers, pending_dir, db_session):
        """已记录的 pending 文件不重复扫描"""
        csv_path = os.path.join(pending_dir, "dup.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")

        # 第一次扫描
        client.post("/results/scan", headers=auth_headers)
        # 第二次扫描 — 应跳过
        resp = client.post("/results/scan", headers=auth_headers)
        assert resp.json()["scanned"] == 0


class TestResultsDownload:
    """POST /results/{id}/download 测试"""

    def test_download_success(self, client, test_user, auth_headers, pending_dir, published_dir):
        """下载已发布结果"""
        # 先创建并通过审查
        csv_path = os.path.join(pending_dir, "downloadable.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")

        client.post("/results/scan", headers=auth_headers)
        resp = client.get("/results/mine", headers=auth_headers)
        published = resp.json()["published"]
        assert len(published) == 1

        result_id = published[0]["id"]
        dl_resp = client.post(f"/results/{result_id}/download", headers=auth_headers)
        assert dl_resp.status_code == 200
        assert dl_resp.headers["content-type"] == "application/octet-stream"

    def test_download_nonexistent(self, client, test_user, auth_headers):
        """下载不存在的结果返回 404"""
        resp = client.post("/results/9999/download", headers=auth_headers)
        assert resp.status_code == 404

    def test_download_increases_count(self, client, test_user, auth_headers, pending_dir, published_dir, db_session):
        """下载次数递增"""
        csv_path = os.path.join(pending_dir, "counter.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")

        client.post("/results/scan", headers=auth_headers)
        result_id = client.get("/results/mine", headers=auth_headers).json()["published"][0]["id"]

        client.post(f"/results/{result_id}/download", headers=auth_headers)
        client.post(f"/results/{result_id}/download", headers=auth_headers)

        exp = db_session.query(ExportResult).filter(ExportResult.id == result_id).first()
        assert exp.download_count == 2

    def test_download_creates_audit_log(self, client, test_user, auth_headers, pending_dir, published_dir, db_session):
        """下载创建审计日志"""
        csv_path = os.path.join(pending_dir, "dl_audit.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            f.write("mean\n1.0\n")

        client.post("/results/scan", headers=auth_headers)
        result_id = client.get("/results/mine", headers=auth_headers).json()["published"][0]["id"]
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

    @patch("app.routers.session.subprocess.Popen")
    def test_full_workflow(self, mock_popen, client, test_user, auth_headers, pending_dir, published_dir, db_session):
        """完整流程：登录 → 启动会话 → 保存结果 → 扫描审查 → 下载"""
        mock_popen.return_value = MagicMock()

        # 1. 验证身份
        resp = client.get("/auth/me", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["username"] == "user1"

        # 2. 启动 RStudio 会话
        resp = client.post("/session/launch/rstudio", headers=auth_headers)
        assert resp.status_code == 200
        assert "guac_url" in resp.json()

        # 3. 模拟用户保存结果到 pending 目录
        csv_path = os.path.join(pending_dir, "final_results.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["term", "estimate", "std_err", "p_value"])
            writer.writerow(["x1", "0.85", "0.05", "0.001"])
            writer.writerow(["x2", "-0.3", "0.1", "0.005"])

        # 4. 扫描审查
        resp = client.post("/results/scan", headers=auth_headers)
        assert resp.status_code == 200
        scan_data = resp.json()
        assert scan_data["scanned"] == 1
        assert scan_data["results"][0]["status"] == "approved"

        # 5. 查看我的结果
        resp = client.get("/results/mine", headers=auth_headers)
        data = resp.json()
        assert len(data["published"]) == 1
        assert data["published"][0]["result_name"] == "final_results.csv"
        result_id = data["published"][0]["id"]

        # 6. 下载结果
        resp = client.post(f"/results/{result_id}/download", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.headers["content-type"] == "application/octet-stream"

        # 7. 验证审计日志记录了整个流程
        logs = db_session.query(AuditLog).all()
        actions = [log.action for log in logs]
        assert "session_launch" in actions
        assert "result_approved" in actions
        assert "result_download" in actions

    @patch("app.routers.session.subprocess.Popen")
    def test_rejected_workflow(self, mock_popen, client, test_user, auth_headers, pending_dir, db_session):
        """被拒绝的流程：保存含敏感数据的文件"""
        mock_popen.return_value = MagicMock()

        # 模拟用户保存含手机号的文件
        csv_path = os.path.join(pending_dir, "sensitive.csv")
        with open(csv_path, "w", encoding="utf-8-sig", newline="") as f:
            writer = csv.writer(f)
            writer.writerow(["mean", "note"])
            writer.writerow(["1.0", "电话13812345678"])

        resp = client.post("/results/scan", headers=auth_headers)
        scan_data = resp.json()
        assert scan_data["results"][0]["status"] == "rejected"

        # 验证无已发布结果
        resp = client.get("/results/mine", headers=auth_headers)
        data = resp.json()
        assert data["published"] == []

        # 验证审计日志记录了拒绝
        logs = db_session.query(AuditLog).filter(
            AuditLog.action == "result_rejected"
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
