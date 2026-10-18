"""pytest 全局配置与 fixtures"""
import os
import tempfile
from typing import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

# 在导入 app 之前覆盖配置，使用 SQLite 内存数据库 + 临时目录
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["JWT_SECRET"] = "test-secret-key-for-unit-tests"
os.environ["DEMO_ADMIN_PASSWORD"] = "admin123"
os.environ["DEMO_USER_PASSWORD"] = "user123"
os.environ["FILESERVER_ROOT"] = tempfile.mkdtemp(prefix="stats_test_")
# 测试环境不连真实 Windows 云主机同步本地账号
os.environ["WINDOWS_ACCOUNT_SYNC"] = "false"
# 测试环境关闭认证接口限流（B1）：全部用例发自同一 testclient IP，会误触阈值
os.environ["RATE_LIMIT_ENABLED"] = "false"
# 强制置空，防止在服务器上跑测试时读到生产 .env 的真实 Guacamole 库连接串
# （否则 guac_sync_enabled() 为真，A4「未启用同步 503」用例失效，且可能写入真实 guac 库）
os.environ["GUAC_DB_URL"] = ""

# ---- 创建测试引擎并 monkey-patch database 模块 ----
TEST_ENGINE = create_engine(
    "sqlite:///:memory:",
    connect_args={"check_same_thread": False},
)
TestSessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=TEST_ENGINE)

# 在导入 app 之前覆盖 database 模块的 engine 和 SessionLocal
import app.database as _db_module
_db_module.engine = TEST_ENGINE
_db_module.SessionLocal = TestSessionLocal

from app.config import settings
settings.database_url = "sqlite:///:memory:"
settings.jwt_secret = "test-secret-key-for-unit-tests"
settings.fileserver_root = os.environ["FILESERVER_ROOT"]
settings.guac_db_url = ""
settings.rate_limit_enabled = False
# 固定原始数据基线为不存在的路径：相似度规则下"无基线"安全默认转人工审核，
# 使既有用例的审批流程断言保持确定性（相似度专项用例自行 monkeypatch）
settings.dataset_csv_path = os.path.join(
    os.environ["FILESERVER_ROOT"], "__missing_baseline__.csv")

from app.database import Base, get_db
from app.models import User, Scope, AuditLog
from app.auth import create_access_token, DEMO_USERS
from app.main import app

# 创建所有表
Base.metadata.drop_all(bind=TEST_ENGINE)
Base.metadata.create_all(bind=TEST_ENGINE)


def override_get_db():
    """覆盖 FastAPI 的 get_db 依赖，使用测试数据库"""
    db = TestSessionLocal()
    try:
        yield db
    finally:
        db.close()


app.dependency_overrides[get_db] = override_get_db


@pytest.fixture(scope="function")
def db_session():
    """每个测试函数独立的数据库会话。

    SQLAlchemy 2.0 官方测试模式：外层事务 + join_transaction_mode="create_savepoint"，
    会话 commit 只释放保存点、测试结束整体回滚实现隔离；路由代码中的
    db.begin_nested()（B9 并发兜底保存点）在该模式下正常工作，
    旧式 begin_nested + after_transaction_end 配方会与之冲突（事务被提前关闭）。
    """
    connection = TEST_ENGINE.connect()
    transaction = connection.begin()
    session = TestSessionLocal(bind=connection, join_transaction_mode="create_savepoint")

    # 每个测试前清空数据
    for table in reversed(Base.metadata.sorted_tables):
        session.execute(table.delete())
    session.commit()

    yield session

    session.close()
    transaction.rollback()
    connection.close()


@pytest.fixture(scope="function")
def client(db_session):
    """TestClient，使用覆盖后的 get_db"""
    def _override():
        try:
            yield db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@pytest.fixture
def test_scope(db_session):
    """创建测试数据范围"""
    scope = Scope(
        scope_code="dept_1",
        scope_type="dept",
        scope_name="测试部门",
        data_path=os.path.join(settings.fileserver_root, "data", "dept_1"),
    )
    db_session.add(scope)
    db_session.commit()
    db_session.refresh(scope)
    return scope


@pytest.fixture
def test_user(db_session, test_scope):
    """创建测试普通用户（默认持有 test_scope 数据权限——B7 修复后，
    无 scopes 的用户将被拒绝生成/导出；需验证门禁的用例改用 test_user_no_scope）"""
    user = User(
        username="user1",
        display_name="测试用户1",
        dept_id=test_scope.id,
        role="user",
        is_active=True,
    )
    user.scopes = [test_scope]
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def test_user_no_scope(db_session):
    """创建无数据权限（scopes 为空）的测试用户，用于验证 B7 权限门禁"""
    user = User(
        username="user_noscope",
        display_name="无权限用户",
        role="user",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def test_admin(db_session, test_scope):
    """创建测试管理员"""
    user = User(
        username="admin",
        display_name="管理员",
        dept_id=test_scope.id,
        role="admin",
        is_active=True,
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture
def user_token(test_user):
    """普通用户 JWT Token"""
    return create_access_token(test_user.id, test_user.username, "user")


@pytest.fixture
def admin_token(test_admin):
    """管理员 JWT Token"""
    return create_access_token(test_admin.id, test_admin.username, "admin")


@pytest.fixture
def auth_headers(user_token):
    """带认证信息的请求头"""
    return {"Authorization": f"Bearer {user_token}"}


@pytest.fixture
def admin_headers(admin_token):
    """管理员认证请求头"""
    return {"Authorization": f"Bearer {admin_token}"}


@pytest.fixture(autouse=True)
def _no_remote_pending_pull(monkeypatch):
    """默认禁止「申请导出」真实 SFTP 回拉 Windows 待导出目录。

    旧有用例直接把文件写在服务器本地 pending 目录模拟；回拉链路的用例
    （test_results_pull.py）会自行恢复真实函数并注入 SFTP 替身。
    """
    from app.routers import results as results_routes
    monkeypatch.setattr(results_routes, "pull_user_pending",
                        lambda user, local_dir: [])


@pytest.fixture
def pending_dir(test_user):
    """创建测试用户的 pending 目录（每个测试前清空）"""
    import shutil
    d = os.path.join(settings.fileserver_root, "pending", str(test_user.id))
    if os.path.exists(d):
        shutil.rmtree(d)
    os.makedirs(d, exist_ok=True)
    return d


@pytest.fixture
def workspace_dir(test_user):
    """创建测试用户的 workspace 目录（每个测试前清空）"""
    import shutil
    d = os.path.join(settings.fileserver_root, "workspace", str(test_user.id))
    if os.path.exists(d):
        shutil.rmtree(d)
    os.makedirs(d, exist_ok=True)
    return d


@pytest.fixture
def published_dir():
    """创建 published 根目录（每个测试前清空）"""
    import shutil
    d = os.path.join(settings.fileserver_root, "published")
    if os.path.exists(d):
        shutil.rmtree(d)
    os.makedirs(d, exist_ok=True)
    return d
