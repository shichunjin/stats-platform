"""数据申请路由：用户提交/查看申请，管理员查看队列/驳回"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, DataApply, Message, AuditLog
from app.auth import get_current_user, require_admin
from app.schemas import DataApplyCreate, DataApplyRejectRequest

router = APIRouter(tags=["数据申请"])

VALID_PRIORITIES = {"low", "medium", "high"}
VALID_STATUSES = {"pending", "processing", "completed", "rejected"}


def _parse_dt(value: Optional[str]) -> Optional[datetime]:
    """解析 ISO 时间字符串，空值返回 None。"""
    if not value:
        return None
    try:
        # 兼容末尾 Z（UTC）
        return datetime.fromisoformat(value.replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"时间格式无法解析: {value}")


def _to_dict(a: DataApply) -> dict:
    return {
        "id": a.id,
        "data_name": a.data_name,
        "purpose": a.purpose,
        "fields": a.fields or [],
        "time_range": [
            a.time_start.isoformat() if a.time_start else None,
            a.time_end.isoformat() if a.time_end else None,
        ],
        "priority": a.priority,
        "status": a.status,
        "reject_reason": a.reject_reason,
        "apply_time": a.created_at.isoformat() if a.created_at else None,
        "finish_time": a.finished_at.isoformat() if a.finished_at else None,
        "target_user_id": a.user_id,
    }


# ============================================================
# 用户端
# ============================================================

@router.post("/user/data-applies", summary="提交数据申请")
def create_apply(
    payload: DataApplyCreate,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    priority = payload.priority if payload.priority in VALID_PRIORITIES else "medium"
    time_range = payload.time_range or []
    time_start = _parse_dt(time_range[0] if len(time_range) > 0 else None)
    time_end = _parse_dt(time_range[1] if len(time_range) > 1 else None)

    apply_obj = DataApply(
        user_id=user.id,
        data_name="testData",
        purpose=payload.purpose,
        fields=payload.fields,
        time_start=time_start,
        time_end=time_end,
        priority=priority,
        status="pending",
    )
    db.add(apply_obj)
    db.add(AuditLog(user_id=user.id, action="data_apply_create",
                    detail=f"提交数据申请，用途：{payload.purpose[:50]}"))
    db.commit()
    db.refresh(apply_obj)
    return _to_dict(apply_obj)


@router.get("/user/data-applies", summary="我的数据申请列表")
def my_applies(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    rows = (
        db.query(DataApply)
        .filter(DataApply.user_id == user.id)
        .order_by(DataApply.created_at.desc(), DataApply.id.desc())
        .all()
    )
    return [_to_dict(a) for a in rows]


# ============================================================
# 管理员端
# ============================================================

@router.get("/admin/data-applies", summary="数据申请队列（管理员）")
def admin_list_applies(
    status: Optional[str] = None,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    q = db.query(DataApply)
    if status:
        if status not in VALID_STATUSES:
            raise HTTPException(status_code=422, detail=f"非法状态: {status}")
        q = q.filter(DataApply.status == status)
    rows = q.order_by(DataApply.created_at.desc(), DataApply.id.desc()).all()
    return [_to_dict(a) for a in rows]


@router.post("/admin/data-applies/{apply_id}/reject", summary="驳回数据申请（管理员）")
def admin_reject_apply(
    apply_id: int,
    payload: DataApplyRejectRequest,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    apply_obj = db.query(DataApply).filter(DataApply.id == apply_id).first()
    if apply_obj is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if apply_obj.status == "completed":
        raise HTTPException(status_code=400, detail="已完成的申请不能驳回")

    apply_obj.status = "rejected"
    apply_obj.reject_reason = payload.reason
    apply_obj.finished_at = datetime.utcnow()
    apply_obj.processed_by = admin.id

    db.add(Message(
        user_id=apply_obj.user_id,
        title="您的数据申请被驳回",
        content=f"申请 #{apply_obj.id} 已被驳回，原因：{payload.reason}",
        msg_type="warning",
        link="/user/my-requests",
    ))
    db.add(AuditLog(user_id=admin.id, action="data_apply_reject",
                    detail=f"驳回申请 #{apply_obj.id}：{payload.reason}"))
    db.commit()
    db.refresh(apply_obj)
    return _to_dict(apply_obj)
