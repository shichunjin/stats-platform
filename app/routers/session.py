"""会话路由: POST /session/launch/{software}"""
import subprocess
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, Session as SessionModel, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.schemas import SessionOut

router = APIRouter(prefix="/session", tags=["会话"])

SOFTWARE_MAP = {
    "rstudio": settings.rstudio_path,
    "mplus": settings.mplus_path,
    "stata": settings.stata_path,
}


@router.post("/launch/{software}", response_model=SessionOut, summary="启动远程软件会话", description="""
**启动远程统计软件会话**

通过 Apache Guacamole 在 Windows Server 上启动指定的统计软件，返回浏览器访问 URL。

**支持的软件**
- `rstudio`：RStudio Desktop
- `mplus`：Mplus Editor
- `stata`：StataSE 18

**业务流程**
1. 在数据库创建会话记录
2. 调用 PowerShell 脚本映射网络驱动器、启动软件进程
3. 返回 Guacamole 访问 URL，用户通过浏览器使用软件

**错误码**
- `400`：不支持的软件名称
- `401`：未认证
- `500`：远程会话启动失败
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

    # 调用 PowerShell 脚本在 Windows Server 上创建远程会话
    # 实际生产中通过 SSH/WinRM 远程执行
    ps_command = [
        "powershell.exe", "-ExecutionPolicy", "Bypass", "-File",
        settings.ps_login_script,
        "-Username", user.username,
        "-UserId", str(user.id),
        "-DeptId", str(user.dept_id or 0),
        "-Software", software,
        "-GuacId", guac_id,
    ]

    try:
        # 异步执行，不等待完成
        subprocess.Popen(ps_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except Exception as e:
        session.status = "ended"
        db.commit()
        raise HTTPException(status_code=500, detail=f"远程会话启动失败: {str(e)}")

    guac_url = f"{settings.guacamole_url}{guac_id}"

    return SessionOut(
        id=session.id,
        software=session.software,
        status=session.status,
        guac_url=guac_url,
        launched_at=session.launched_at,
    )
