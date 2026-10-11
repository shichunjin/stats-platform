"""FastAPI 入口 — 统计软件托管平台"""
import os
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from app.routers import auth, session, results, admin, data, messages, applies
from app.database import Base, engine, SessionLocal
from app.models import User, Scope, AuditLog
from app.auth import DEMO_ACCOUNTS, DEMO_USERS

# 创建数据库表（生产环境建议用 Alembic 迁移）
Base.metadata.create_all(bind=engine)


def _init_demo_data():
    """初始化演示账号和默认部门（仅在不存在时创建）"""
    db = SessionLocal()
    try:
        # 默认部门
        scope = db.query(Scope).filter(Scope.scope_code == "dept_default").first()
        if scope is None:
            scope = Scope(
                scope_code="dept_default",
                scope_type="dept",
                scope_name="默认部门",
                data_path=r"\\fileserver\data\dept_default",
            )
            db.add(scope)
            db.commit()
            db.refresh(scope)

        # 演示账号（仅创建已配置密码的账号）
        for username, (display_name, role) in DEMO_ACCOUNTS.items():
            if username not in DEMO_USERS:
                continue  # 未配置密码，跳过创建
            if not db.query(User).filter(User.username == username).first():
                db.add(User(
                    username=username,
                    display_name=display_name,
                    dept_id=scope.id,
                    role=role,
                    is_active=True,
                    # 演示账号不用 password_hash，登录时用 DEMO_USERS 字典校验
                ))
        db.commit()
    finally:
        db.close()


_init_demo_data()

app = FastAPI(
    title="统计软件托管平台",
    description="""
# 统计软件托管平台 API 文档

在 **不修改无源码 Windows 桌面软件** 的前提下，让用户通过浏览器使用 RStudio、Mplus Editor、StataSE 18 等统计软件。

## 核心能力

- **软件权限**：所有登录用户都可以使用所有软件（不做软件级权限）
- **数据权限**：每个用户只能看到 / 读取自己部门或项目范围内的数据
- **原始数据保护**：用户不能下载、拷贝、导出原始数据文件
- **结果导出**：分析完成后的"结果数据"可以导出，但必须经过平台审查
- **多用户并行**：多个用户可同时使用同一款软件，互不干扰

## 接口分类

- **认证模块** (`/auth`)：登录、获取当前用户信息
- **会话模块** (`/session`)：启动远程统计软件会话
- **结果模块** (`/results`)：查看/扫描/下载分析结果
- **管理员模块** (`/admin`)：审计日志、待审查文件管理
""",
    version="1.0.0",
    openapi_tags=[
        {"name": "认证", "description": "用户登录与身份验证相关接口"},
        {"name": "用户", "description": "用户信息查询接口"},
        {"name": "会话", "description": "远程统计软件会话管理接口"},
        {"name": "结果", "description": "分析结果审查与下载接口"},
        {"name": "管理员", "description": "管理员专属接口（需管理员权限）"},
    ],
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # 生产环境改为前端域名
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(session.router)
app.include_router(results.router)
app.include_router(admin.router)
app.include_router(data.router)
app.include_router(messages.router)
app.include_router(applies.router)


@app.get("/health", tags=["认证"], summary="健康检查", description="检查服务运行状态，无需认证。")
def health():
    return {"status": "ok"}


# ---- 前端页面托管 ----
# 优先托管 Vue 构建产物 frontend/dist（生产）；未构建时回退旧版静态 HTML（本地开发用 5173）
_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_FRONTEND_DIST = os.path.join(_REPO_ROOT, "frontend", "dist")
_SPA_INDEX = os.path.join(_FRONTEND_DIST, "index.html")

if os.path.isfile(_SPA_INDEX):
    # hashed 静态资源
    _assets_dir = os.path.join(_FRONTEND_DIST, "assets")
    if os.path.isdir(_assets_dir):
        app.mount("/assets", StaticFiles(directory=_assets_dir), name="assets")

    @app.middleware("http")
    async def spa_history_fallback(request: Request, call_next):
        """浏览器地址栏导航/刷新（Accept: text/html）统一回退到 SPA 入口。

        前端 history 路由与部分 API 路径同名（如 /admin/audit），axios 请求
        不带 text/html，会正常进入 API；仅整页导航命中此前端回退。
        """
        accept = request.headers.get("accept", "")
        if request.method == "GET" and "text/html" in accept:
            path = request.url.path
            if not path.startswith(
                ("/docs", "/redoc", "/openapi.json", "/assets", "/static", "/health")
            ):
                return FileResponse(_SPA_INDEX)
        return await call_next(request)

    @app.get("/{full_path:path}", response_class=HTMLResponse, include_in_schema=False)
    def spa_entry(full_path: str):
        """前端路由（history 模式）统一回退到 index.html；已注册 API 路由优先匹配，不会进入这里。"""
        # dist 根目录下的真实文件（favicon.ico 等）直接返回
        if full_path:
            candidate = os.path.realpath(os.path.join(_FRONTEND_DIST, full_path))
            if candidate.startswith(os.path.realpath(_FRONTEND_DIST) + os.sep) \
                    and os.path.isfile(candidate):
                return FileResponse(candidate)
        return FileResponse(_SPA_INDEX)

else:
    # 未构建前端时的兜底：旧版静态页面 + 根路径服务信息
    _STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
    app.mount("/static", StaticFiles(directory=_STATIC_DIR), name="static")

    @app.get("/", tags=["认证"], summary="服务根路径", description="返回平台基本信息和接口端点列表。")
    def root():
        return {
            "service": "统计软件托管平台",
            "docs": "/docs",
            "login_page": "/login",
            "endpoints": {
                "register": "POST /auth/register",
                "login": "POST /auth/login",
                "me": "GET /auth/me",
                "connect": "POST /session/connect",
                "fetch_data": "POST /data/fetch",
                "my_results": "GET /results/mine",
                "request_export": "POST /results/request-export",
                "download": "POST /results/{id}/download",
                "audit": "GET /admin/audit",
            },
        }

    @app.get("/login", response_class=HTMLResponse, include_in_schema=False)
    def login_page():
        """登录/注册页面"""
        with open(os.path.join(_STATIC_DIR, "login.html"), "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())

    @app.get("/dashboard", response_class=HTMLResponse, include_in_schema=False)
    def dashboard_page():
        """控制台页面"""
        with open(os.path.join(_STATIC_DIR, "dashboard.html"), "r", encoding="utf-8") as f:
            return HTMLResponse(f.read())


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
