"""auth.py 单元测试 — JWT 认证模块"""
import jwt
import pytest
from datetime import datetime, timedelta

from app.auth import (
    verify_password,
    create_access_token,
    DEMO_USERS,
)
from app.config import settings


# ============================================================
# 测试：密码验证
# ============================================================

class TestVerifyPassword:
    """verify_password 函数测试"""

    def test_correct_admin_password(self):
        assert verify_password("admin", "admin123") is True

    def test_correct_user_password(self):
        assert verify_password("user1", "user123") is True

    def test_wrong_password(self):
        assert verify_password("admin", "wrong") is False

    def test_nonexistent_user(self):
        assert verify_password("nobody", "any") is False

    def test_empty_username(self):
        assert verify_password("", "any") is False

    def test_empty_password(self):
        assert verify_password("admin", "") is False

    def test_case_sensitive_username(self):
        """用户名大小写敏感"""
        assert verify_password("Admin", "admin123") is False

    def test_case_sensitive_password(self):
        """密码大小写敏感"""
        assert verify_password("admin", "ADMIN123") is False


# ============================================================
# 测试：JWT Token 签发
# ============================================================

class TestCreateAccessToken:
    """create_access_token 函数测试"""

    def test_token_is_valid_jwt(self):
        """Token 是有效的 JWT 字符串"""
        token = create_access_token(1, "user1", "user")
        assert isinstance(token, str)
        # JWT 格式: header.payload.signature
        assert token.count(".") == 2

    def test_token_contains_user_id(self):
        """Token 中包含用户 ID"""
        token = create_access_token(42, "testuser", "user")
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        assert payload["sub"] == "42"

    def test_token_contains_username(self):
        """Token 中包含用户名"""
        token = create_access_token(1, "testuser", "user")
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        assert payload["username"] == "testuser"

    def test_token_contains_role(self):
        """Token 中包含角色"""
        token = create_access_token(1, "admin", "admin")
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        assert payload["role"] == "admin"

    def test_token_has_expiration(self):
        """Token 有过期时间"""
        token = create_access_token(1, "user1", "user")
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        assert "exp" in payload

        exp = datetime.utcfromtimestamp(payload["exp"])
        now = datetime.utcnow()
        # 过期时间应该在 7~9 小时之间（默认 8 小时）
        delta = exp - now
        assert 7 <= delta.total_seconds() / 3600 <= 9

    def test_expired_token_fails_decode(self):
        """过期的 Token 解码会抛异常"""
        # 手动构造过期 payload
        payload = {
            "sub": "1",
            "username": "user1",
            "role": "user",
            "exp": datetime.utcnow() - timedelta(hours=1),  # 1小时前过期
        }
        expired_token = jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)
        with pytest.raises(jwt.ExpiredSignatureError):
            jwt.decode(expired_token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

    def test_token_tampered_fails(self):
        """篡改的 Token 解码失败"""
        token = create_access_token(1, "user1", "user")
        tampered = token[:-5] + "XXXXX"
        with pytest.raises((jwt.InvalidSignatureError, jwt.DecodeError, Exception)):
            jwt.decode(tampered, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

    def test_different_users_different_tokens(self):
        """不同用户生成不同 Token"""
        token1 = create_access_token(1, "user1", "user")
        token2 = create_access_token(2, "user2", "user")
        assert token1 != token2


# ============================================================
# 测试：DEMO_USERS 数据
# ============================================================

class TestDemoUsers:
    """演示用户数据验证"""

    def test_admin_exists(self):
        assert "admin" in DEMO_USERS

    def test_user1_exists(self):
        assert "user1" in DEMO_USERS

    def test_admin_has_password(self):
        assert DEMO_USERS["admin"] == "admin123"

    def test_user1_has_password(self):
        assert DEMO_USERS["user1"] == "user123"
