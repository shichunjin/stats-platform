"""认证路由: POST /auth/register, POST /auth/login, GET /auth/me, POST /auth/change-password"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, AuditLog
from app.auth import (
    verify_password, create_access_token, get_current_user, hash_password,
    validate_password_strength,
    DEMO_ACCOUNTS,
)
from app.guac import upsert_guac_user
from app.windows_account import sync_windows_user
from app.rate_limit import rate_limit_auth, get_client_ip
from app.schemas import (
    LoginRequest, TokenResponse, UserOut, RegisterRequest, RegisterResponse,
    ChangePasswordRequest,
)

router = APIRouter(prefix="/auth", tags=["认证"])


@router.post("/register", response_model=RegisterResponse, summary="用户注册", description="""
**用户注册接口**

- 用户名 3-20 位（字母/数字/._-，将同时作为 Windows 云桌面登录账号），不可与已有用户（含演示账号）重名
- 密码 8-64 字符，须包含大写字母、小写字母、数字、特殊符号中的至少三类，且不能包含用户名；使用 pbkdf2_sha256 哈希存储
  （与 Windows 云主机密码复杂度策略一致，注册即开通云桌面，无需再改密）
- 新注册用户角色固定为 `user`，需管理员后续分配数据范围
- 注册成功后即可用账号密码登录
- 启用同步时，会同时创建 Windows 云主机本地账号与 Guacamole 同名用户（同密码），
  浏览器可一键直连本人专属云桌面

**错误码**
- `400`：用户名已被占用或参数校验失败
- `422`：用户名/密码格式不合法
- `502`：Windows 或 Guacamole 账号同步失败（平台账号不会创建，可修正后重试）
""")
def register(
    req: RegisterRequest,
    request: Request,
    _rl: None = Depends(rate_limit_auth),
    db: Session = Depends(get_db),
):
    # 用户名查重（包含演示账号保留名）
    if req.username in DEMO_ACCOUNTS:
        raise HTTPException(status_code=400, detail=f"用户名 '{req.username}' 已被占用")
    existing = db.query(User).filter(User.username == req.username).first()
    if existing:
        raise HTTPException(status_code=400, detail=f"用户名 '{req.username}' 已被占用")

    # 密码强度前置校验（对齐 Windows 复杂度策略，避免同步到云主机时才被拒）
    try:
        validate_password_strength(req.password, req.username)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # 外部系统同步顺序：Windows 本地账号 → Guacamole → 平台账号。
    # 三者按用户名幂等，任何一步失败都整体失败（502），平台不产生半完成账号，
    # 用户修正问题后可直接重试。
    try:
        sync_windows_user(req.username, req.password)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{e}（平台账号未创建，可修正后重试）")

    try:
        upsert_guac_user(req.username, req.password)
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail=f"Guacamole 用户同步失败: {e}（平台账号未创建，可修正后重试）")

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
        ip_addr=get_client_ip(request),
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
def login(
    req: LoginRequest,
    request: Request,
    _rl: None = Depends(rate_limit_auth),
    db: Session = Depends(get_db),
):
    client_ip = get_client_ip(request)
    user = db.query(User).filter(User.username == req.username).first()
    if user is None:
        db.add(AuditLog(
            user_id=None,
            action="login",
            detail=f"登录失败（用户不存在）: {req.username}",
            ip_addr=client_ip,
            status="failed",
        ))
        db.commit()
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    if not user.is_active:
        raise HTTPException(status_code=403, detail="账号已被禁用")

    if not verify_password(req.username, req.password, db_user=user):
        db.add(AuditLog(
            user_id=user.id,
            action="login",
            detail=f"登录失败（密码错误）: {req.username}",
            ip_addr=client_ip,
            status="failed",
        ))
        db.commit()
        raise HTTPException(status_code=401, detail="用户名或密码错误")

    token = create_access_token(user.id, user.username, user.role, user.password_version or 1)

    db.add(AuditLog(
        user_id=user.id,
        action="login",
        detail=f"用户 {user.username} 登录",
        ip_addr=client_ip,
    ))
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
- 新密码 8-64 字符，须包含大写字母、小写字母、数字、特殊符号中的至少三类，且不能包含用户名
- 启用同步时，Windows 云主机本地账号、Guacamole 账号密码同步更新
  （先外部后平台，任一失败平台密码不变，三端始终一致）
- 演示账号（admin/user1）密码由环境变量管理，不能在线修改

**错误码**
- `400`：原密码错误 / 演示账号不允许在线改密
- `401`：未认证
- `502`：Windows 或 Guacamole 密码同步失败（平台密码未修改）
""")
def change_password(
    req: ChangePasswordRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    if user.username in DEMO_ACCOUNTS:
        raise HTTPException(status_code=400, detail="演示账号密码由环境变量管理，不能在线修改")

    if not verify_password(user.username, req.old_password, db_user=user):
        raise HTTPException(status_code=400, detail="原密码错误")

    # 新密码强度前置校验（与注册同一套策略，避免同步到云主机时才被拒）
    try:
        validate_password_strength(req.new_password, user.username)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # 外部系统先改：Windows 本地账号 → Guacamole，全部成功后才改平台密码，
    # 保证三端密码一致；任一步失败，平台密码保持原样。
    try:
        sync_windows_user(user.username, req.new_password)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"{e}（平台密码未修改）")

    try:
        upsert_guac_user(user.username, req.new_password)
    except Exception as e:
        raise HTTPException(status_code=502,
                            detail=f"Guacamole 密码同步失败，平台密码未修改: {e}")

    user.password_hash = hash_password(req.new_password)
    user.password_version = (user.password_version or 1) + 1
    db.add(AuditLog(
        user_id=user.id,
        action="change_password",
        detail=f"用户 {user.username} 修改密码",
        ip_addr=get_client_ip(request),
    ))
    db.commit()

    return {"message": "密码修改成功，Windows 云桌面与 Guacamole 登录密码已同步"}
