"""管理员路由: GET /admin/audit, GET /admin/pending"""
from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, AuditLog, PendingFile
from app.auth import get_current_user, require_admin
from app.schemas import AuditLogOut, PendingFileOut

router = APIRouter(prefix="/admin", tags=["管理员"])


@router.get("/audit", response_model=list[AuditLogOut], summary="查询审计日志", description="""
**查询系统审计日志（仅管理员）**

**查询参数**
- `skip`：跳过记录数（分页），默认 0
- `limit`：返回条数上限，默认 100，最大 500
- `action`：按操作类型过滤（如 `login` / `session_launch` / `result_approved` / `result_rejected` / `result_download`）
- `user_id`：按用户 ID 过滤

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_audit_logs(
    skip: int = Query(0, ge=0, description="跳过记录数"),
    limit: int = Query(100, ge=1, le=500, description="返回条数上限"),
    action: str | None = Query(None, description="按操作类型过滤"),
    user_id: int | None = Query(None, description="按用户 ID 过滤"),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查询审计日志（管理员）"""
    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    if user_id:
        q = q.filter(AuditLog.user_id == user_id)
    return q.order_by(AuditLog.created_at.desc()).offset(skip).limit(limit).all()


@router.get("/pending", response_model=list[PendingFileOut], summary="查看所有待审查文件", description="""
**查看所有用户的待审查文件（仅管理员）**

返回所有用户的 pending_files 记录，按创建时间倒序排列。

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_all_pending(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查看所有待审查文件（管理员）"""
    return db.query(PendingFile).order_by(PendingFile.created_at.desc()).all()
