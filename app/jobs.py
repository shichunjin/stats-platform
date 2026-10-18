"""后台任务执行器（性能修复 C1）

单进程部署下的轻量实现：ThreadPoolExecutor 线程池 + 内存在跑集合。
数据生成（Excel 筛选 + SFTP 推送）从请求线程剥离，避免长任务占满
FastAPI 工作线程（压测取数不再阻塞登录等短请求）。
如需多进程/跨机扩展，可替换为 RQ/Celery——任务入口签名
submit_generate(apply_id, fn, **kwargs) 保持不变即可。
"""
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

logger = logging.getLogger(__name__)

# 生成任务是 IO 密集（读库 + SFTP），2 个 worker 足够且避免打满 Windows 侧 SSH
_executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="generate")
_inflight: set[int] = set()  # 正在生成的 apply_id
_lock = threading.Lock()


def submit_generate(apply_id: int, fn, **kwargs) -> bool:
    """提交生成任务；同一申请已有任务在跑时返回 False（防并发双击/重试风暴）。

    fn 在后台线程执行，必须自行管理数据库会话生命周期（生产环境
    请求会话随响应关闭，后台线程不得复用）。
    """
    with _lock:
        if apply_id in _inflight:
            return False
        _inflight.add(apply_id)

    def _runner():
        try:
            fn(**kwargs)
        except Exception:  # noqa: BLE001 — 兜底，任务内部已处理业务异常
            logger.exception("后台生成任务未捕获异常 apply_id=%s", apply_id)
        finally:
            with _lock:
                _inflight.discard(apply_id)

    _executor.submit(_runner)
    return True


def is_inflight(apply_id: int) -> bool:
    """该申请当前是否有任务在跑（用于区分「生成中」与进程重启残留的 stale 状态）"""
    with _lock:
        return apply_id in _inflight
