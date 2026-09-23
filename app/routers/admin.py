"""管理员路由: 审计日志 / 待审查文件 / 用户与数据权限管理"""
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, AuditLog, PendingFile, Scope
from app.auth import get_current_user, require_admin
from app.schemas import (
    AuditLogOut, PendingFileOut, UserAdminOut, ScopeOut, ScopeAssignRequest,
)

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


@router.get("/users", response_model=list[UserAdminOut], summary="查看所有用户", description="""
**查看所有用户及其数据权限（仅管理员）**

返回用户列表，每个用户包含所属部门（dept）和可访问的项目范围（scopes）。

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_all_users(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查看所有用户（管理员）"""
    return db.query(User).order_by(User.id).all()


@router.get("/scopes", response_model=list[ScopeOut], summary="查看所有数据范围", description="""
**查看所有数据范围（仅管理员）**

返回部门/项目范围列表，用于给用户分配数据权限。

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_all_scopes(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查看所有数据范围（管理员）"""
    return db.query(Scope).order_by(Scope.id).all()


@router.put("/users/{user_id}/scopes", response_model=UserAdminOut, summary="分配用户数据权限", description="""
**给指定用户分配数据权限（仅管理员）**

- `dept_id`：设置用户所属部门（可为 null 清空）
- `scope_ids`：设置用户可访问的项目范围列表（覆盖式，传空数组即清空）

**说明**
本平台**不对软件做权限区分**，所有用户均可使用全部软件；用户之间的唯一区别是此处的数据权限。

**错误码**
- `401`：未认证
- `403`：非管理员
- `404`：用户不存在
- `400`：引用的范围 ID 不存在
""")
def assign_user_scopes(
    user_id: int,
    req: ScopeAssignRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """分配用户数据权限（管理员）"""
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 校验 dept_id
    if req.dept_id is not None:
        dept = db.query(Scope).filter(Scope.id == req.dept_id).first()
        if dept is None:
            raise HTTPException(status_code=400, detail=f"部门范围 ID {req.dept_id} 不存在")
        user.dept_id = req.dept_id
    else:
        user.dept_id = None

    # 校验并重建 scopes（覆盖式）
    if req.scope_ids:
        scopes = db.query(Scope).filter(Scope.id.in_(req.scope_ids)).all()
        if len(scopes) != len(set(req.scope_ids)):
            raise HTTPException(status_code=400, detail="存在无效的范围 ID")
        user.scopes = scopes
    else:
        user.scopes = []

    db.add(AuditLog(
        user_id=admin.id,
        action="assign_scopes",
        detail=f"为用户 {user.username}(id={user_id}) 分配数据权限: dept_id={req.dept_id}, scopes={req.scope_ids}",
    ))
    db.commit()
    db.refresh(user)
    return user
