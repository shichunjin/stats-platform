"""认证路由: POST /auth/register, POST /auth/login, GET /auth/me, POST /auth/change-password"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, AuditLog
from app.auth import (
    verify_password, create_access_token, get_current_user, hash_password,
    DEMO_ACCOUNTS,
)
from app.guac import upsert_guac_user
from app.schemas import (
    LoginRequest, TokenResponse, UserOut, RegisterRequest, RegisterResponse,
    ChangePasswordRequest,
)

router = APIRouter(prefix="/auth", tags=["认证"])


@router.post("/register", response_model=RegisterResponse, summary="用户注册", description="""
**用户注册接口**

- 用户名 3-32 字符，不可与已有用户（含演示账号）重名
- 密码 6-64 字符，使用 pbkdf2_sha256 哈希存储
- 新注册用户角色固定为 `user`，需管理员后续分配数据范围
- 注册成功后即可用账号密码登录
- 配置了 Guacamole 同步时，会同时在 Guacamole 中创建同名用户（同密码）

**错误码**
- `400`：用户名已被占用或参数校验失败
- `502`：Guacamole 用户同步失败（平台账号不会创建，保证两边一致）
""")
def register(req: RegisterRequest, db: Session = Depends(get_db)):
    # 用户名查重（包含演示账号保留名）
    if req.username in DEMO_ACCOUNTS:
        raise HTTPException(status_code=400, detail=f"用户名 '{req.username}' 已被占用")
    existing = db.query(User).filter(User.username == req.username).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"用户名 '{req.username}' 已被占用")

    # 先同步 Guacamole（外部系统）；失败则整体失败，平台不产生半完成账号
    try:
        upsert_guac_user(req.username, req.password)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Guacamole 用户同步失败: {e}")

    user = User(
        username=req.username,
        display_name=req.display_name or req.username,
        role="user",
        is_active=True,
        password_hash=hash_password(req.password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    db.add(AuditLog(
        user_id=user.id,
        action="register",
        detail=f"新用户注册: {user.username}",
    ))
    db.commit()

    return RegisterResponse(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        message="注册成功，请使用账号密码登录",
    )


@router.post("/login", response_model=TokenResponse, summary="用户登录", description="""
**用户登录接口**

- 使用用户名和密码登录
- 验证通过后返回 JWT 令牌
- 后续请求需在 `Authorization` 头中携带 `Bearer <令牌>`

**支持的账号**
- 演示账号：`admin` / `admin123`、`user1` / `user123`
- 注册账号：通过 `/auth/register` 注册的账号

**错误码**
- `401`：用户名或密码错误
- `403`：账号已被禁用
""")
def login(req: LoginRequest, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.username == req.username).first()
    if user is None:
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被禁用")

    if not verify_password(req.username, req.password, db_user=user):
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = create_access_token(user.id, user.username, user.role)

    db.add(AuditLog(user_id=user.id, action="login", detail=f"用户 {user.username} 登录"))
    db.commit()

    return TokenResponse(access_token=token)


@router.get("/me", response_model=UserOut, tags=["用户"], summary="获取当前用户信息", description="""
**获取当前登录用户信息**

- 需携带有效的 JWT 令牌
- 返回用户基本信息、所属部门、可访问的数据范围

**错误码**
- `401`：未认证或令牌无效
""")
def get_me(user: User = Depends(get_current_user)):
    return user


@router.post("/change-password", summary="修改密码", description="""
**修改当前登录用户密码**

- 需校验原密码
- 新密码 6-64 字符
- 配置了 Guacamole 同步时，Guacamole 登录密码同步更新（先改 Guacamole，
  成功后再改平台，保证两边密码一致）
- 演示账号（admin/user1）密码由环境变量管理，不能在线修改

**错误码**
- `400`：原密码错误 / 演示账号不允许在线改密
- `401`：未认证
- `502`：Guacamole 密码同步失败（平台密码未修改）
""")
def change_password(
    req: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user.username in DEMO_ACCOUNTS:
        raise HTTPException(status_code=400, detail="演示账号密码由环境变量管理，不能在线修改")

    if not verify_password(user.username, req.old_password, db_user=user):
        raise HTTPException(status_code=400, detail="原密码错误")

    # 先同步 Guacamole；失败则平台密码保持不变，保证两边一致
    try:
        upsert_guac_user(user.username, req.new_password)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Guacamole 密码同步失败，平台密码未修改: {e}")

    user.password_hash = hash_password(req.new_password)
    db.add(AuditLog(user_id=user.id, action="change_password", detail=f"用户 {user.username} 修改密码"))
    db.commit()

    return {"message": "密码修改成功，Guacamole 登录密码已同步"}
