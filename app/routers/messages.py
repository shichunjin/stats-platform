"""消息中心路由：消息列表、标记已读、全部已读"""
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import User, Message
from app.auth import get_current_user

router = APIRouter(prefix="/messages", tags=["消息"])


def _to_dict(m: Message) -> dict:
    return {
        "id": m.id,
        "title": m.title,
        "content": m.content,
        "type": m.msg_type or "info",
        "read": bool(m.is_read),
        "link": m.link,
        "created_at": m.created_at.isoformat() if m.created_at else None,
    }


@router.get("", summary="获取我的消息列表", description="按时间倒序返回当前用户的站内消息。支持 skip/limit 分页（性能修复 C2）。")
def list_messages(
    skip: int = Query(0, ge=0, description="跳过记录数"),
    limit: int = Query(100, ge=1, le=500, description="返回条数上限"),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    msgs = (
        db.query(Message)
        .filter(Message.user_id == user.id)
        .order_by(Message.created_at.desc(), Message.id.desc())
        .offset(skip).limit(limit)
        .all()
    )
    return [_to_dict(m) for m in msgs]


@router.post("/{message_id}/read", summary="标记单条消息为已读")
def mark_read(
    message_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    msg = db.query(Message).filter(
        Message.id == message_id, Message.user_id == user.id
    ).first()
    if msg is None:
        raise HTTPException(status_code=404, detail="消息不存在")
    if not msg.is_read:
        msg.is_read = True
        db.commit()
    return _to_dict(msg)


@router.post("/read-all", summary="全部标记已读")
def mark_all_read(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    count = (
        db.query(Message)
        .filter(Message.user_id == user.id, Message.is_read == False)  # noqa: E712
        .update({Message.is_read: True})
    )
    db.commit()
    return {"count": count}
