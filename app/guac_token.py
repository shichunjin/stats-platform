"""Guacamole authToken 换取与缓存（免密直连）

用户登录成功后，后端用本次输入的明文密码调用 Guacamole REST API
`POST /api/tokens` 换取 authToken，按用户缓存到 guac_auth_tokens 表；
`/session/connect` 返回 `.../#/client/{id}?token=<authToken>`，
Guacamole 前端据此跳过登录页，直接进入该用户的专属 RDP 连接。

设计约束：
- 只缓存 authToken，不保存用户密码；
- Guacamole 未就绪、超时或账号未同步时仅记日志，不影响平台登录；
- 令牌过期后自动清除，连接接口回退为普通地址（用户在 Guacamole 登录一次）。
"""
import logging
from datetime import datetime, timedelta
from typing import Optional

import httpx
from sqlalchemy.orm import Session

from app.config import settings
from app.models import GuacAuthToken

logger = logging.getLogger(__name__)


def _api_base() -> str:
    """Guacamole REST API 基址：显式配置优先，否则由 GUACAMOLE_URL 推导。"""
    if settings.guacamole_api_url:
        return settings.guacamole_api_url.rstrip("/")
    base = settings.guacamole_url.split("/#")[0].rstrip("/")
    return f"{base}/api"


def fetch_auth_token(username: str, password: str) -> Optional[str]:
    """调用 Guacamole REST API 换取 authToken；失败返回 None，不抛异常。"""
    try:
        with httpx.Client(timeout=settings.guac_token_timeout_seconds) as client:
            resp = client.post(
                f"{_api_base()}/tokens",
                data={"username": username, "password": password},
            )
    except Exception as e:  # noqa: BLE001 — 网络异常不应阻断平台登录
        logger.warning("Guacamole 免密令牌获取失败 user=%s: %s", username, e)
        return None

    if resp.status_code != 200:
        logger.info("Guacamole 未返回令牌 user=%s status=%s", username, resp.status_code)
        return None

    try:
        token = resp.json().get("authToken")
    except ValueError:
        logger.warning("Guacamole 令牌响应解析失败 user=%s", username)
        return None
    return str(token) if token else None


def cache_auth_token(db: Session, user_id: int, auth_token: str) -> None:
    """写入/覆盖用户的令牌缓存（调用方负责 commit）。"""
    expires_at = datetime.utcnow() + timedelta(seconds=settings.guac_token_ttl_seconds)
    row = db.get(GuacAuthToken, user_id)
    if row is None:
        db.add(GuacAuthToken(user_id=user_id, auth_token=auth_token, expires_at=expires_at))
    else:
        row.auth_token = auth_token
        row.expires_at = expires_at


def remember_login_token(db: Session, user, password: str) -> None:
    """登录/改密成功后 best-effort 换取并缓存令牌（任何异常都不外抛）。"""
    # 函数内导入避免与 app.guac 产生模块级循环依赖
    from app.guac import guac_sync_enabled

    if not guac_sync_enabled():
        return

    token = fetch_auth_token(user.username, password)
    if not token:
        return
    try:
        cache_auth_token(db, user.id, token)
        db.commit()
    except Exception as e:  # noqa: BLE001 — 缓存失败不影响登录
        db.rollback()
        logger.warning("缓存 Guacamole 令牌失败 user=%s: %s", user.username, e)


def get_valid_auth_token(db: Session, user_id: int) -> Optional[str]:
    """读取未过期的令牌；已过期则清除并返回 None。"""
    row = db.get(GuacAuthToken, user_id)
    if row is None:
        return None
    if row.expires_at is None or row.expires_at <= datetime.utcnow():
        db.delete(row)
        db.commit()
        return None
    return row.auth_token
