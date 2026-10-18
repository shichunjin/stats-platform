"""认证模块：JWT 签发与校验、密码哈希、密码强度策略"""
import base64
import hashlib
import hmac
import os
import re
from datetime import datetime, timedelta
from typing import Optional

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from app.config import settings
from app.database import get_db
from app.models import User

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login", auto_error=False)

# 演示账号元数据（用户名 -> (显示名, 角色)）
DEMO_ACCOUNTS = {
    "admin": ("管理员", "admin"),
    "user1": ("测试用户1", "user"),
}

# 演示账号密码（从环境变量读取，未配置的账号默认禁用登录）
DEMO_USERS = {}
if settings.demo_admin_password:
    DEMO_USERS["admin"] = settings.demo_admin_password
if settings.demo_user_password:
    DEMO_USERS["user1"] = settings.demo_user_password


# ---- 密码哈希（使用 pbkdf2_hmac，无需额外依赖） ----

# ---- 密码强度策略（与 Windows 默认密码复杂度策略对齐并适度加强） ----
PASSWORD_MIN_LENGTH = 8
PASSWORD_MAX_LENGTH = 64
# 四类字符：小写字母、大写字母、数字、特殊符号；至少包含三类
_PASSWORD_CATEGORY_PATTERNS = (
    re.compile(r"[a-z]"),
    re.compile(r"[A-Z]"),
    re.compile(r"[0-9]"),
    re.compile(r"[^A-Za-z0-9]"),
)


def validate_password_strength(password: str, username: Optional[str] = None) -> None:
    """校验密码强度，不合法抛 ValueError（中文信息可直接返回给前端）。

    规则：
    - 长度 8-64；
    - 大写字母 / 小写字母 / 数字 / 特殊符号四类中至少包含三类
      （即 Windows「密码必须符合复杂性要求」）；
    - 不得包含用户名（长度 ≥3 时按子串、不区分大小写），
      同样对齐 Windows SAM 对账号名片段的限制。
    """
    if not isinstance(password, str):
        raise ValueError("密码格式不正确")
    if len(password) < PASSWORD_MIN_LENGTH or len(password) > PASSWORD_MAX_LENGTH:
        raise ValueError(f"密码长度必须为 {PASSWORD_MIN_LENGTH}-{PASSWORD_MAX_LENGTH} 位")
    if any(ch.isspace() for ch in password):
        # 平台不允许空白字符，避免前后端/远程执行链路的歧义
        raise ValueError("密码不能包含空格或换行")

    categories = sum(1 for pattern in _PASSWORD_CATEGORY_PATTERNS if pattern.search(password))
    if categories < 3:
        raise ValueError("密码需至少包含大写字母、小写字母、数字、特殊符号中的三类")

    if username and len(username) >= 3 and username.lower() in password.lower():
        raise ValueError("密码不能包含用户名")


def hash_password(password: str) -> str:
    """生成密码哈希（pbkdf2_sha256，格式：pbkdf2$<salt_b64>$<hash_b64>）"""
    salt = os.urandom(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
    return f"pbkdf2${base64.b64encode(salt).decode()}${base64.b64encode(dk).decode()}"


def verify_password_hash(password: str, stored: str) -> bool:
    """验证密码与哈希是否匹配"""
    if not stored or not stored.startswith("pbkdf2$"):
        return False
    try:
        _, salt_b64, hash_b64 = stored.split("$")
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
        dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, 100000)
        # 常量时间比较，避免计时攻击
        return hashlib.sha256(dk).digest() == hashlib.sha256(expected).digest()
    except Exception:
        return False


def verify_password(username: str, password: str, db_user: Optional[User] = None) -> bool:
    """
    验证密码：
    1. 先匹配演示账号（DEMO_USERS）
    2. 再校验数据库用户的 password_hash
    """
    # 演示账号（安全修复 C6：hmac.compare_digest 常量时间比较，防时序侧信道）
    demo_pw = DEMO_USERS.get(username)
    if demo_pw is not None and hmac.compare_digest(
            demo_pw.encode("utf-8"), password.encode("utf-8")):
        return True
    # 数据库注册用户
    if db_user and db_user.password_hash:
        return verify_password_hash(password, db_user.password_hash)
    return False


def create_access_token(user_id: int, username: str, role: str, password_version: int = 1) -> str:
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "pwd_ver": password_version,
        "exp": datetime.utcnow() + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def get_current_user(
    token: Optional[str] = Depends(oauth2_scheme),
    db: Session = Depends(get_db),
) -> User:
    credentials_exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="无法验证凭据",
        headers={"WWW-Authenticate": "Bearer"},
    )
    if not token:
        raise credentials_exc
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        user_id = int(payload.get("sub"))
    except (jwt.PyJWTError, ValueError, TypeError):
        raise credentials_exc

    user = db.query(User).filter(User.id == user_id, User.is_active == True).first()
    if user is None:
        raise credentials_exc

    # 安全修复 B2：改密后旧 JWT 立即失效。
    # 旧 token（无 pwd_ver 字段）视为版本 0，与当前版本（≥1）不匹配即拒绝。
    token_pwd_ver = payload.get("pwd_ver", 0)
    if token_pwd_ver != (user.password_version or 1):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="凭据已过期，请重新登录",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user
