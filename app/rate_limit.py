"""限流模块：登录/注册接口防爆破（B1 安全修复）

纯内存滑动窗口限流，无外部依赖。按 IP + 端点 维度计数，
窗口内超过阈值返回 429。生产环境如需分布式限流可替换为 Redis。
"""
import threading
import time
from collections import defaultdict
from typing import Tuple

from fastapi import HTTPException, Request


class SlidingWindowRateLimiter:
    """滑动窗口限流器（线程安全，内存实现）"""

    def __init__(self):
        self._lock = threading.Lock()
        # key -> list[timestamp]
        self._hits: dict[str, list[float]] = defaultdict(list)

    def _cleanup(self, key: str, window_seconds: int) -> None:
        """清理窗口外的过期记录"""
        cutoff = time.monotonic() - window_seconds
        self._hits[key] = [t for t in self._hits[key] if t > cutoff]

    def check(self, key: str, max_attempts: int, window_seconds: int) -> Tuple[bool, int]:
        """
        检查是否允许通过。
        返回 (allowed, remaining_seconds_to_wait)
        """
        with self._lock:
            self._cleanup(key, window_seconds)
            hits = self._hits[key]
            if len(hits) < max_attempts:
                hits.append(time.monotonic())
                return True, 0
            # 计算最早一次尝试何时滑出窗口
            oldest = hits[0]
            wait = int(window_seconds - (time.monotonic() - oldest)) + 1
            return False, max(wait, 1)


# 全局限流器实例
_limiter = SlidingWindowRateLimiter()


def get_client_ip(request: Request) -> str:
    """从请求中提取客户端 IP，优先取 X-Forwarded-For（经 nginx 反代后）"""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        # X-Forwarded-For: client, proxy1, proxy2 —— 取第一个（真实客户端）
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def rate_limit_auth(request: Request) -> None:
    """
    认证接口限流依赖：
    - 登录：每 IP 每 60 秒最多 5 次
    - 注册：每 IP 每 300 秒最多 3 次（注册即开 Windows 账号，需更严格）
    """
    ip = get_client_ip(request)
    path = request.url.path

    if path.endswith("/auth/register"):
        allowed, wait = _limiter.check(f"reg:{ip}", max_attempts=3, window_seconds=300)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"注册请求过于频繁，请 {wait} 秒后重试",
            )
    elif path.endswith("/auth/login"):
        allowed, wait = _limiter.check(f"login:{ip}", max_attempts=5, window_seconds=60)
        if not allowed:
            raise HTTPException(
                status_code=429,
                detail=f"登录尝试过于频繁，请 {wait} 秒后重试",
            )
