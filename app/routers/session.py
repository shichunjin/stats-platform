"""会话路由: POST /session/connect"""
import uuid
from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, Session as SessionModel, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.schemas import SessionOut

router = APIRouter(prefix="/session", tags=["会话"])


@router.post("/connect", response_model=SessionOut, summary="连接 Windows 分析平台", description="""
**连接 Windows 分析平台**

用户点击一个按钮即可通过 Apache Guacamole 连接到 Windows Server，
进入分析环境后按登录用户身份做数据控制（数据权限在 Windows 登录脚本
及文件服务器 ACL 中落实）。不再区分具体软件，所有软件均在 Windows 内可用。

**业务流程**
1. 创建会话记录（供审计）
2. 返回 Guacamole 通用 RDP 连接 URL，用户通过浏览器连接 Windows

**错误码**
- `401`：未认证
""")
def connect_session(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    guac_id = f"windows-{user.username}-{uuid.uuid4().hex[:8]}"

    session = SessionModel(
        user_id=user.id,
        software="windows",
        guac_identifier=guac_id,
        status="active",
    )
    db.add(session)

    db.add(AuditLog(
        user_id=user.id,
        action="session_connect",
        detail=f"连接 Windows 分析平台, guac_id={guac_id}",
    ))
    db.commit()
    db.refresh(session)

    guac_url = f"{settings.guacamole_url}{settings.guacamole_connection_id}"

    return SessionOut(
        id=session.id,
        software=session.software,
        status=session.status,
        guac_url=guac_url,
        launched_at=session.launched_at,
    )
