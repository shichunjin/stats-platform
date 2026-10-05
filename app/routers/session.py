"""会话路由: POST /session/launch/{software}"""
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, Session as SessionModel, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.schemas import SessionOut

router = APIRouter(prefix="/session", tags=["会话"])

# 支持的软件标识（软件本体在 Windows Server 上，由登录脚本/桌面快捷方式启动）
SOFTWARE_MAP = {
    "rstudio": settings.rstudio_path,
    "mplus": settings.mplus_path,
    "stata": settings.stata_path,
}


@router.post("/launch/{software}", response_model=SessionOut, summary="启动远程软件会话", description="""
**启动远程统计软件会话**

通过 Apache Guacamole 连接到 Windows Server，用户登录后通过桌面快捷方式
启动对应的统计软件，返回浏览器访问 URL。

**支持的软件**
- `rstudio`：RStudio Desktop
- `mplus`：Mplus Editor
- `stata`：StataSE 18

**业务流程**
1. 在数据库创建会话记录（记录用户启动的软件，供审计）
2. 返回 Guacamole 通用 RDP 连接 URL，用户通过浏览器连接 Windows
3. Windows 登录脚本（login.ps1）自动映射盘符、创建桌面快捷方式
4. 用户在 Windows 内点击快捷方式启动对应软件

**错误码**
- `400`：不支持的软件名称
- `401`：未认证
""")
def launch_session(
    software: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    software = software.lower()
    if software not in SOFTWARE_MAP:
        raise HTTPException(status_code=400, detail=f"不支持的软件: {software}（可选: rstudio|mplus|stata）")

    guac_id = f"{software}-{user.username}-{uuid.uuid4().hex[:8]}"

    # 创建数据库会话记录
    session = SessionModel(
        user_id=user.id,
        software=software,
        guac_identifier=guac_id,
        status="active",
    )
    db.add(session)

    db.add(AuditLog(
        user_id=user.id,
        action="session_launch",
        detail=f"启动 {software} 会话, guac_id={guac_id}",
    ))
    db.commit()
    db.refresh(session)

    # 返回 Guacamole 通用 RDP 连接 URL（软件由 Windows 登录脚本/桌面快捷方式启动）
    guac_url = f"{settings.guacamole_url}{settings.guacamole_connection_id}"

    return SessionOut(
        id=session.id,
        software=session.software,
        status=session.status,
        guac_url=guac_url,
        launched_at=session.launched_at,
    )
