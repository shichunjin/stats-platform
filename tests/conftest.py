"""pytest 全局配置与 fixtures"""
import os
import tempfile
from typing import Generator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

# 在导入 app 之前覆盖配置，使用 SQLite 内存数据库 + 临时目录
os.environ["DATABASE_URL"] = "sqlite:///:memory:"
os.environ["JWT_SECRET"] = "test-secret-key-for-unit-tests"
os.environ["FILESERVER_ROOT"] = tempfile.mkdtemp(prefix="stats_test_")

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
    """每个测试函数独立的数据库会话（使用 SAVEPOINT 实现隔离）"""
    connection = TEST_ENGINE.connect()
    transaction = connection.begin()
    session = TestSessionLocal(bind=connection)

    # 开始嵌套事务（SAVEPOINT）
    session.begin_nested()

    # 当 session commit 后，自动重新开始 SAVEPOINT
    @event.listens_for(session, "after_transaction_end")
    def restart_savepoint(session, transaction):
        if transaction.nested and not transaction._parent.nested:
            session.begin_nested()

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
    """创建测试普通用户"""
    user = User(
        username="user1",
        display_name="测试用户1",
        dept_id=test_scope.id,
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
