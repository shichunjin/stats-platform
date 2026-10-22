"""三档角色体系测试：user / admin / superadmin

覆盖：
- require_admin 放行 admin 与 superadmin，拒绝普通用户
- require_superadmin 仅放行 superadmin
- /admin/manage/users 列表与角色变更接口的白名单/自改/超管保护/404
- 角色变更后旧 JWT 立即失效（password_version +1）
- 角色变更写审计日志
- app.cli promote / demote-super 服务器本地命令
"""
import jwt as pyjwt
import pytest

from app.auth import create_access_token
from app.cli import demote_super, promote
from app.config import settings
from app.models import AuditLog, User


# ============================================================
# 守卫行为
# ============================================================

class TestRequireAdmin:
    def test_admin_passes(self, client, test_admin, admin_headers):
        resp = client.get("/admin/users", headers=admin_headers)
        assert resp.status_code == 200

    def test_superadmin_passes_admin_endpoints(self, client, test_superadmin, superadmin_headers):
        """超管天然拥有全部管理员权限"""
        resp = client.get("/admin/users", headers=superadmin_headers)
        assert resp.status_code == 200

    def test_user_rejected(self, client, test_user, auth_headers):
        resp = client.get("/admin/users", headers=auth_headers)
        assert resp.status_code == 403


class TestRequireSuperadmin:
    def test_superadmin_passes(self, client, test_superadmin, superadmin_headers):
        resp = client.get("/admin/manage/users", headers=superadmin_headers)
        assert resp.status_code == 200
        roles = {u["username"]: u["role"] for u in resp.json()}
        assert roles["superadmin1"] == "superadmin"

    def test_admin_rejected(self, client, test_admin, admin_headers):
        resp = client.get("/admin/manage/users", headers=admin_headers)
        assert resp.status_code == 403
        assert "超级管理员" in resp.json()["detail"]

    def test_user_rejected(self, client, test_user, auth_headers):
        resp = client.get("/admin/manage/users", headers=auth_headers)
        assert resp.status_code == 403

    def test_unauthenticated_rejected(self, client):
        resp = client.get("/admin/manage/users")
        assert resp.status_code == 401


# ============================================================
# 角色变更接口
# ============================================================

class TestUpdateUserRole:
    def test_promote_user_to_admin(self, client, test_user, test_superadmin, superadmin_headers, db_session):
        resp = client.put(f"/admin/manage/users/{test_user.id}/role",
                          headers=superadmin_headers, json={"role": "admin"})
        assert resp.status_code == 200
        assert resp.json()["role"] == "admin"
        db_session.refresh(test_user)
        assert test_user.role == "admin"

    def test_demote_admin_to_user(self, client, test_admin, test_superadmin, superadmin_headers, db_session):
        resp = client.put(f"/admin/manage/users/{test_admin.id}/role",
                          headers=superadmin_headers, json={"role": "user"})
        assert resp.status_code == 200
        db_session.refresh(test_admin)
        assert test_admin.role == "user"

    def test_reject_superadmin_role_value(self, client, test_user, test_superadmin, superadmin_headers, db_session):
        """接口层禁止创建 superadmin"""
        resp = client.put(f"/admin/manage/users/{test_user.id}/role",
                          headers=superadmin_headers, json={"role": "superadmin"})
        assert resp.status_code == 400
        db_session.refresh(test_user)
        assert test_user.role == "user"

    def test_reject_invalid_role_value(self, client, test_user, test_superadmin, superadmin_headers):
        resp = client.put(f"/admin/manage/users/{test_user.id}/role",
                          headers=superadmin_headers, json={"role": "root"})
        assert resp.status_code == 400

    def test_reject_self_modification(self, client, test_superadmin, superadmin_headers):
        resp = client.put(f"/admin/manage/users/{test_superadmin.id}/role",
                          headers=superadmin_headers, json={"role": "admin"})
        assert resp.status_code == 400
        assert "自己" in resp.json()["detail"]

    def test_reject_operating_other_superadmin(self, client, test_superadmin, superadmin_headers, db_session):
        other = User(username="super2", display_name="超管2", role="superadmin", is_active=True)
        db_session.add(other)
        db_session.commit()
        resp = client.put(f"/admin/manage/users/{other.id}/role",
                          headers=superadmin_headers, json={"role": "user"})
        assert resp.status_code == 400
        db_session.refresh(other)
        assert other.role == "superadmin"

    def test_user_not_found(self, client, test_superadmin, superadmin_headers):
        resp = client.put("/admin/manage/users/99999/role",
                          headers=superadmin_headers, json={"role": "admin"})
        assert resp.status_code == 404

    def test_idempotent_same_role(self, client, test_user, test_superadmin, superadmin_headers, db_session):
        """角色未变化时不递增 password_version、不写审计"""
        ver_before = test_user.password_version
        resp = client.put(f"/admin/manage/users/{test_user.id}/role",
                          headers=superadmin_headers, json={"role": "user"})
        assert resp.status_code == 200
        db_session.refresh(test_user)
        assert test_user.password_version == ver_before

    def test_old_token_invalidated_after_role_change(
            self, client, test_user, test_superadmin, superadmin_headers, db_session):
        """角色变更后目标用户旧 JWT 立即失效"""
        old_token = create_access_token(test_user.id, test_user.username, "user")
        client.put(f"/admin/manage/users/{test_user.id}/role",
                   headers=superadmin_headers, json={"role": "admin"})
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {old_token}"})
        assert resp.status_code == 401

    def test_audit_log_written(self, client, test_user, test_superadmin, superadmin_headers, db_session):
        client.put(f"/admin/manage/users/{test_user.id}/role",
                   headers=superadmin_headers, json={"role": "admin"})
        log = db_session.query(AuditLog).filter(
            AuditLog.action == "update_user_role",
            AuditLog.user_id == test_superadmin.id,
        ).first()
        assert log is not None
        assert test_user.username in log.detail
        assert "user" in log.detail and "admin" in log.detail


# ============================================================
# 服务器本地 CLI
# ============================================================

class TestCli:
    def test_promote_user(self, test_user, db_session):
        assert promote("user1") == 0
        db_session.refresh(test_user)
        assert test_user.role == "superadmin"

    def test_promote_idempotent(self, test_superadmin, db_session, capsys):
        assert promote("superadmin1") == 0
        db_session.refresh(test_superadmin)
        assert test_superadmin.role == "superadmin"
        assert "已是超级管理员" in capsys.readouterr().out

    def test_promote_nonexistent(self, capsys):
        assert promote("no_such_user") == 1
        assert "不存在" in capsys.readouterr().err

    def test_promote_invalidates_old_token(self, client, test_user, db_session):
        old_token = create_access_token(test_user.id, test_user.username, "user")
        promote("user1")
        resp = client.get("/auth/me", headers={"Authorization": f"Bearer {old_token}"})
        assert resp.status_code == 401

    def test_demote_super(self, test_superadmin, db_session):
        assert demote_super("superadmin1") == 0
        db_session.refresh(test_superadmin)
        assert test_superadmin.role == "admin"

    def test_demote_non_super(self, test_user, db_session, capsys):
        assert demote_super("user1") == 0
        db_session.refresh(test_user)
        assert test_user.role == "user"

    def test_cli_audit_log(self, test_user, db_session):
        promote("user1")
        log = db_session.query(AuditLog).filter(AuditLog.action == "cli_role_change").first()
        assert log is not None
        assert "server-cli" in log.detail


# ============================================================
# JWT 角色声明
# ============================================================

class TestRoleClaim:
    def test_token_carries_superadmin_role(self, test_superadmin):
        token = create_access_token(test_superadmin.id, test_superadmin.username, "superadmin")
        payload = pyjwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        assert payload["role"] == "superadmin"

