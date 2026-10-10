"""管理员路由: 审计日志 / 待审查文件 / 用户与数据权限管理 / 导出审核"""
import os
import shutil
from fastapi import APIRouter, Depends, Query, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, AuditLog, PendingFile, ExportResult, Scope
from app.auth import get_current_user, require_admin
from app.config import settings
from app.schemas import (
    AuditLogOut, PendingFileOut, UserAdminOut, ScopeOut, ScopeAssignRequest,
    ExportReviewRequest,
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


@router.get("/pending", response_model=list[PendingFileOut], summary="查看待审核的导出申请", description="""
**查看所有待审核的导出申请（仅管理员）**

返回所有 `status=pending` 的导出申请，按创建时间倒序排列。

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_all_pending(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查看所有待审核的导出申请（管理员）"""
    return db.query(PendingFile).filter(
        PendingFile.status == "pending"
    ).order_by(PendingFile.created_at.desc()).all()


def _published_dir(result_id: int) -> str:
    d = os.path.join(settings.fileserver_root, "published", str(result_id))
    os.makedirs(d, exist_ok=True)
    return d


@router.post("/pending/{pending_id}/approve", summary="审核通过导出申请", description="""
**审核通过导出申请（仅管理员）**

- 将待审核文件复制到 published 目录
- 创建可下载的导出结果记录
- 更新申请状态为 `approved`

**错误码**
- `401`：未认证
- `403`：非管理员
- `404`：申请不存在或已处理
- `400`：源文件已丢失
""")
def approve_pending(
    pending_id: int,
    req: ExportReviewRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    pf = db.query(PendingFile).filter(PendingFile.id == pending_id).first()
    if pf is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if pf.status != "pending":
        raise HTTPException(status_code=400, detail="该申请已处理")

    if not os.path.exists(pf.file_path):
        raise HTTPException(status_code=400, detail="源文件已丢失")

    pub_dir = _published_dir(pf.id)
    pub_path = os.path.join(pub_dir, pf.file_name)
    shutil.copy2(pf.file_path, pub_path)

    exp = ExportResult(
        user_id=pf.user_id,
        pending_file_id=pf.id,
        result_name=pf.file_name,
        file_path=pub_path,
        file_size=pf.file_size,
    )
    db.add(exp)

    pf.status = "approved"
    pf.review_reason = req.reason or "审核通过"
    pf.reviewed_by = admin.id

    db.add(AuditLog(
        user_id=admin.id,
        action="export_approved",
        detail=f"审核通过导出申请 {pf.file_name} (id={pending_id}, 用户id={pf.user_id})",
    ))
    db.commit()
    db.refresh(pf)
    return PendingFileOut.model_validate(pf)


@router.post("/pending/{pending_id}/reject", summary="审核拒绝导出申请", description="""
**审核拒绝导出申请（仅管理员）**

- 更新申请状态为 `rejected`
- 记录拒绝原因

**错误码**
- `401`：未认证
- `403`：非管理员
- `404`：申请不存在或已处理
""")
def reject_pending(
    pending_id: int,
    req: ExportReviewRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    pf = db.query(PendingFile).filter(PendingFile.id == pending_id).first()
    if pf is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if pf.status != "pending":
        raise HTTPException(status_code=400, detail="该申请已处理")

    pf.status = "rejected"
    pf.review_reason = req.reason or "审核拒绝"
    pf.reviewed_by = admin.id

    db.add(AuditLog(
        user_id=admin.id,
        action="export_rejected",
        detail=f"审核拒绝导出申请 {pf.file_name} (id={pending_id}, 用户id={pf.user_id}): {pf.review_reason}",
    ))
    db.commit()
    db.refresh(pf)
    return PendingFileOut.model_validate(pf)


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
