"""服务器本地管理命令：超级管理员账号的创建与降级。

超级管理员不允许通过任何 HTTP API 产生（见 routers/admin.py 的角色白名单），
只能在服务器本机执行：

    # 将已有用户提升为超级管理员
    ./venv/bin/python -m app.cli promote <username>

    # 应急：将超级管理员降回普通管理员
    ./venv/bin/python -m app.cli demote-super <username>

两个命令均幂等，并写入审计日志（操作人记录为 server-cli）。
"""
import argparse
import sys

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import AuditLog, User

VALID_ROLES = ("user", "admin", "superadmin")


def _audit(db, user: User, detail: str) -> None:
    db.add(AuditLog(user_id=user.id, action="cli_role_change", detail=detail))


def promote(username: str, db: Session | None = None) -> int:
    """将用户提升为超级管理员。db 仅供测试注入，生产不传、由本函数自建会话。"""
    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if user is None:
            print(f"错误: 用户不存在: {username}", file=sys.stderr)
            return 1
        if user.role == "superadmin":
            print(f"{username} 已是超级管理员，无需变更")
            return 0
        old_role = user.role
        user.role = "superadmin"
        # 角色变化后旧 JWT 立即失效（与 API 路径同一机制）
        user.password_version = (user.password_version or 1) + 1
        _audit(db, user, f"[server-cli] 角色由 {old_role} 提升为 superadmin")
        db.commit()
        print(f"OK: {username} 已提升为超级管理员（旧登录态已失效，需重新登录）")
        return 0
    finally:
        if own_session:
            db.close()


def demote_super(username: str, db: Session | None = None) -> int:
    """将超级管理员降回管理员。db 仅供测试注入。"""
    own_session = db is None
    if own_session:
        db = SessionLocal()
    try:
        user = db.query(User).filter(User.username == username).first()
        if user is None:
            print(f"错误: 用户不存在: {username}", file=sys.stderr)
            return 1
        if user.role != "superadmin":
            print(f"{username} 当前角色为 {user.role}，不是超级管理员，无需变更")
            return 0
        user.role = "admin"
        user.password_version = (user.password_version or 1) + 1
        _audit(db, user, "[server-cli] 角色由 superadmin 降级为 admin")
        db.commit()
        print(f"OK: {username} 已降级为管理员（旧登录态已失效，需重新登录）")
        return 0
    finally:
        if own_session:
            db.close()


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python -m app.cli",
        description="服务器本地管理命令（超级管理员创建/降级，无 HTTP 入口）",
    )
    sub = parser.add_subparsers(dest="command", required=True)
    p_promote = sub.add_parser("promote", help="将已有用户提升为超级管理员")
    p_promote.add_argument("username")
    p_demote = sub.add_parser("demote-super", help="将超级管理员降回管理员（应急）")
    p_demote.add_argument("username")
    args = parser.parse_args()

    if args.command == "promote":
        return promote(args.username)
    return demote_super(args.username)


if __name__ == "__main__":
    sys.exit(main())
