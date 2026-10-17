"""会话路由: POST /session/connect"""
import uuid
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, Session as SessionModel, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.schemas import SessionOut
from app.guac import (
    guac_sync_enabled, get_user_connection_id, ensure_user_connection,
)

router = APIRouter(prefix="/session", tags=["会话"])


@router.post("/connect", response_model=SessionOut, summary="连接数据分析PC", description="""
**连接数据分析PC（原“连接 Windows 分析平台”）**

用户点击按钮即可通过 Apache Guacamole 连接到 Windows Server。
启用 Guacamole JDBC 同步后，每个用户使用**按用户名分配的专属 RDP 连接**
（连接参数中 RDP 用户名锁定为本人），进入分析环境后由 Windows 登录脚本
与文件服务器 ACL 按身份落实数据隔离；未启用同步时回退到共享连接 ID。

**业务流程**
1. 查找（必要时补偿创建）该用户的专属 RDP 连接
2. 创建会话记录（供审计）
3. 返回带专属连接 ID 的 Guacamole URL

**错误码**
- `401`：未认证
- `503`：Guacamole 侧未就绪（未启用 JDBC 同步，或用户未同步，需修改一次密码或联系管理员）
""")
def connect_session(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    guac_id = f"windows-{user.username}-{uuid.uuid4().hex[:8]}"

    # 解析该用户要使用的 Guacamole 连接
    if guac_sync_enabled():
        connection_id = get_user_connection_id(user.username)
        if connection_id is None:
            # 老用户补偿：账号已同步但专属连接缺失（如本功能上线前注册）
            connection_id = ensure_user_connection(user.username)
        if connection_id is None:
            raise HTTPException(
                status_code=503,
                detail="远程桌面环境尚未就绪，请修改一次密码或联系管理员同步账号",
            )
        connection_ref = str(connection_id)
    else:
        # 安全修复 A4：未启用 Guacamole JDBC 同步时无法保证一人一专属连接，
        # 所有用户会共享同一连接（会话串号、凭据互见），拒绝建立会话。
        # 生产部署必须配置 GUAC_DB_URL 启用同步；本地开发同理需配置后才能联调远程桌面。
        raise HTTPException(
            status_code=503,
            detail="远程桌面服务未启用用户级连接同步（GUAC_DB_URL 未配置），已拒绝共享连接，请联系管理员",
        )

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
        detail=f"连接数据分析PC, guac_id={guac_id}, connection_id={connection_ref}",
    ))
    db.commit()
    db.refresh(session)

    guac_url = f"{settings.guacamole_url}{connection_ref}"

    return SessionOut(
        id=session.id,
        software=session.software,
        status=session.status,
        guac_url=guac_url,
        launched_at=session.launched_at,
    )
