"""认证模块：JWT 签发与校验、密码哈希"""
import base64
import hashlib
import os
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

# 简单演示：实际环境对接 AD/LDAP
DEMO_USERS = {
    "admin": "admin123",
    "user1": "user123",
}


# ---- 密码哈希（使用 pbkdf2_hmac，无需额外依赖） ----

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
    # 演示账号
    if DEMO_USERS.get(username) == password:
        return True
    # 数据库注册用户
    if db_user and db_user.password_hash:
        return verify_password_hash(password, db_user.password_hash)
    return False


def create_access_token(user_id: int, username: str, role: str) -> str:
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
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
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user
