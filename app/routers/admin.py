"""管理员路由: 审计日志 / 待审查文件 / 用户与数据权限管理 / 导出审核"""
import os
import shutil
import ipaddress
from fastapi import APIRouter, Depends, Query, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session, joinedload
from app.database import get_db
from app.models import User, AuditLog, PendingFile, ExportResult, Scope
from app.auth import get_current_user, require_admin
from app.config import settings
from app.rate_limit import get_client_ip
from app.review import file_sha256
from app.schemas import (
    AuditLogOut, PendingFileOut, UserAdminOut, ScopeOut, ScopeAssignRequest,
    ExportReviewRequest,
)

router = APIRouter(prefix="/admin", tags=["管理员"])


@router.get("/audit", response_model=list[AuditLogOut], summary="查询审计日志", description="""
**查询系统审计日志（仅管理员）**

**查询参数**
- `skip`：跳过记录数（分页），默认 0
- `limit`：返回条数上限，默认 100，最大 500
- `action`：按操作类型过滤（如 `login` / `session_launch` / `result_approved` / `result_rejected` / `result_download`）
- `user_id`：按用户 ID 过滤

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_audit_logs(
    skip: int = Query(0, ge=0, description="跳过记录数"),
    limit: int = Query(100, ge=1, le=500, description="返回条数上限"),
    action: str | None = Query(None, description="按操作类型过滤"),
    user_id: int | None = Query(None, description="按用户 ID 过滤"),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查询审计日志（管理员）"""
    q = db.query(AuditLog)
    if action:
        q = q.filter(AuditLog.action == action)
    if user_id:
        q = q.filter(AuditLog.user_id == user_id)
    return q.order_by(AuditLog.created_at.desc()).offset(skip).limit(limit).all()


@router.get("/pending", response_model=list[PendingFileOut], summary="查看待审核的导出申请", description="""
**查看所有待审核的导出申请（仅管理员）**

返回所有 `status=pending` 的导出申请，按创建时间倒序排列。

**查询参数（性能修复 C2：分页）**
- `skip`：跳过记录数，默认 0
- `limit`：返回条数上限，默认 100，最大 500

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_all_pending(
    skip: int = Query(0, ge=0, description="跳过记录数"),
    limit: int = Query(100, ge=1, le=500, description="返回条数上限"),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查看所有待审核的导出申请（管理员）"""
    return db.query(PendingFile).filter(
        PendingFile.status == "pending"
    ).order_by(
        PendingFile.created_at.desc(), PendingFile.id.desc()
    ).offset(skip).limit(limit).all()


def _published_dir(result_id: int) -> str:
    d = os.path.join(settings.fileserver_root, "published", str(result_id))
    os.makedirs(d, exist_ok=True)
    return d


@router.post("/pending/{pending_id}/approve", summary="审核通过导出申请", description="""
**审核通过导出申请（仅管理员）**

- 将待审核文件复制到 published 目录
- 创建可下载的导出结果记录
- 更新申请状态为 `approved`

**错误码**
- `401`：未认证
- `403`：非管理员
- `404`：申请不存在或已处理
- `400`：源文件已丢失
""")
def approve_pending(
    pending_id: int,
    req: ExportReviewRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    client_ip = get_client_ip(request)
    # 性能修复 C3：行锁读取（PostgreSQL SELECT ... FOR UPDATE；SQLite 为 no-op，
    # 由下方「status 条件更新 rowcount==1」兜底并发双击）
    pf = db.query(PendingFile).filter(
        PendingFile.id == pending_id
    ).with_for_update().first()
    if pf is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if pf.status != "pending":
        raise HTTPException(status_code=400, detail="该申请已处理")

    if not os.path.exists(pf.file_path):
        raise HTTPException(status_code=400, detail="源文件已丢失")

    # 安全修复 B9：审核通过前复核文件内容与申请时一致，
    # 防止「申请后改写待导出文件」使未经审查的内容被发布。
    if pf.content_sha:
        try:
            current_sha = file_sha256(pf.file_path)
        except OSError:
            raise HTTPException(status_code=400, detail="源文件已丢失")
        if current_sha != pf.content_sha:
            db.add(AuditLog(
                user_id=admin.id,
                action="export_approved",
                detail=f"审核通过被阻止（文件内容已变更）: {pf.file_name} (id={pending_id}, 用户id={pf.user_id})",
                status="failed",
                ip_addr=client_ip,
            ))
            db.commit()
            raise HTTPException(
                status_code=409,
                detail="文件内容与申请时不一致（可能已被修改），请驳回该申请并要求用户重新提交",
            )

    # 性能修复 C3：先以「status=pending」条件更新认领该申请，rowcount==1 才复制文件。
    # 两个管理员并行点击 approve 时，未抢到更新的一方直接 409，
    # 保证同一申请只会产生一条 ExportResult（前面未提交任何变更，直接报错即可安全回滚）。
    claimed = db.query(PendingFile).filter(
        PendingFile.id == pending_id,
        PendingFile.status == "pending",
    ).update({"status": "approved"}, synchronize_session=False)
    if claimed != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="该申请已被其他管理员处理，请刷新列表")
    pf.status = "approved"  # 同步会话内对象状态（条件更新绕过了会话缓存）

    pub_dir = _published_dir(pf.id)
    pub_path = os.path.join(pub_dir, pf.file_name)
    shutil.copy2(pf.file_path, pub_path)

    # 有效期：审核通过后 30 天内可下载，过期自动拒绝
    from datetime import datetime, timedelta
    expires_at = datetime.utcnow() + timedelta(days=30)

    exp = ExportResult(
        user_id=pf.user_id,
        pending_file_id=pf.id,
        result_name=pf.file_name,
        file_path=pub_path,
        file_size=pf.file_size,
        expires_at=expires_at,
    )
    db.add(exp)

    pf.review_reason = req.reason or "审核通过"
    pf.reviewed_by = admin.id

    db.add(AuditLog(
        user_id=admin.id,
        action="export_approved",
        detail=f"审核通过导出申请 {pf.file_name} (id={pending_id}, 用户id={pf.user_id})",
        ip_addr=client_ip,
    ))
    db.commit()
    db.refresh(pf)
    return PendingFileOut.model_validate(pf)


@router.post("/pending/{pending_id}/reject", summary="审核拒绝导出申请", description="""
**审核拒绝导出申请（仅管理员）**

- 更新申请状态为 `rejected`
- 记录拒绝原因

**错误码**
- `401`：未认证
- `403`：非管理员
- `404`：申请不存在或已处理
""")
def reject_pending(
    pending_id: int,
    req: ExportReviewRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    pf = db.query(PendingFile).filter(PendingFile.id == pending_id).first()
    if pf is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if pf.status != "pending":
        raise HTTPException(status_code=400, detail="该申请已处理")

    pf.status = "rejected"
    pf.review_reason = req.reason or "审核拒绝"
    pf.reviewed_by = admin.id

    db.add(AuditLog(
        user_id=admin.id,
        action="export_rejected",
        detail=f"审核拒绝导出申请 {pf.file_name} (id={pending_id}, 用户id={pf.user_id}): {pf.review_reason}",
        ip_addr=get_client_ip(request),
    ))
    db.commit()
    db.refresh(pf)
    return PendingFileOut.model_validate(pf)


@router.get("/users", response_model=list[UserAdminOut], summary="查看所有用户", description="""
**查看所有用户及其数据权限（仅管理员）**

返回用户列表，每个用户包含所属部门（dept）和可访问的项目范围（scopes）。

**查询参数（性能修复 C2：分页 + joinedload 消除 N+1）**
- `skip`：跳过记录数，默认 0
- `limit`：返回条数上限，默认 500，最大 1000

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_all_users(
    skip: int = Query(0, ge=0, description="跳过记录数"),
    limit: int = Query(500, ge=1, le=1000, description="返回条数上限"),
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查看所有用户（管理员）"""
    # 性能修复 C2：joinedload 一次性取回 dept/scopes，避免逐用户 N+1 查询
    return db.query(User).options(
        joinedload(User.dept), joinedload(User.scopes),
    ).order_by(User.id).offset(skip).limit(limit).all()


@router.get("/scopes", response_model=list[ScopeOut], summary="查看所有数据范围", description="""
**查看所有数据范围（仅管理员）**

返回部门/项目范围列表，用于给用户分配数据权限。

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def get_all_scopes(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """查看所有数据范围（管理员）"""
    return db.query(Scope).order_by(Scope.id).all()


@router.put("/users/{user_id}/scopes", response_model=UserAdminOut, summary="分配用户数据权限", description="""
**给指定用户分配数据权限（仅管理员）**

- `dept_id`：设置用户所属部门（可为 null 清空）
- `scope_ids`：设置用户可访问的项目范围列表（覆盖式，传空数组即清空）

**说明**
本平台**不对软件做权限区分**，所有用户均可使用全部软件；用户之间的唯一区别是此处的数据权限。

**错误码**
- `401`：未认证
- `403`：非管理员
- `404`：用户不存在
- `400`：引用的范围 ID 不存在
""")
def assign_user_scopes(
    user_id: int,
    req: ScopeAssignRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    """分配用户数据权限（管理员）"""
    user = db.query(User).filter(User.id == user_id).first()
    if user is None:
        raise HTTPException(status_code=404, detail="用户不存在")

    # 校验 dept_id
    if req.dept_id is not None:
        dept = db.query(Scope).filter(Scope.id == req.dept_id).first()
        if dept is None:
            raise HTTPException(status_code=400, detail=f"部门范围 ID {req.dept_id} 不存在")
        user.dept_id = req.dept_id
    else:
        user.dept_id = None

    # 校验并重建 scopes（覆盖式）
    if req.scope_ids:
        scopes = db.query(Scope).filter(Scope.id.in_(req.scope_ids)).all()
        if len(scopes) != len(set(req.scope_ids)):
            raise HTTPException(status_code=400, detail="存在无效的范围 ID")
        user.scopes = scopes
    else:
        user.scopes = []

    db.add(AuditLog(
        user_id=admin.id,
        action="assign_scopes",
        detail=f"为用户 {user.username}(id={user_id}) 分配数据权限: dept_id={req.dept_id}, scopes={req.scope_ids}",
        ip_addr=get_client_ip(request),
    ))
    db.commit()
    db.refresh(user)
    return user


class PlatformTestRequest(BaseModel):
    """测试连接数据分析PC的请求参数"""
    host: str
    port: int = 22
    username: str
    password: str = ""


def _is_allowed_test_host(host: str) -> bool:
    """安全修复 B3：限制测试连接目标，防止 SSRF。

    允许的目标：
    - 配置文件中已知的 SFTP/RDS 主机（settings.sftp_host / settings.rds_host）
    - 私有 IP 段（内网部署场景）
    - localhost / 127.0.0.1
    禁止：公网任意 IP（防止被用作跳板扫描/攻击第三方）。
    """
    if host in (settings.sftp_host, settings.rds_host, "localhost", "127.0.0.1"):
        return True
    try:
        ip = ipaddress.ip_address(host)
        return ip.is_private
    except ValueError:
        return False  # 域名解析结果不可控，禁止


@router.post("/platform/test", summary="测试连接数据分析PC", description="""
**测试与数据分析PC（Windows）的 SSH/SFTP 连通性（仅管理员）**

用于「连接数据分析PC」页面的测试连接按钮：
- 尝试建立 SSH 连接并认证
- 成功返回耗时；失败返回具体错误信息（网络不通 / 认证失败等）

**安全限制（B3 修复）**
- 目标主机必须是配置文件中已知的 SFTP/RDS 主机，或私有 IP 段
- 禁止对公网任意 IP 发起连接，防止 SSRF/跳板攻击

**错误码**
- `400`：目标主机不在允许列表
- `401`：未认证
- `403`：非管理员
- `502`：连接失败（detail 为具体原因）
""")
def test_platform_connection(
    req: PlatformTestRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    client_ip = get_client_ip(request)
    # 安全修复 B3：SSRF 防护——限制可测试的目标主机
    if not _is_allowed_test_host(req.host):
        db.add(AuditLog(
            user_id=admin.id,
            action="platform_test",
            detail=f"测试连接被拒绝（目标不允许）: {req.host}:{req.port}",
            status="failed",
            ip_addr=client_ip,
        ))
        db.commit()
        raise HTTPException(
            status_code=400,
            detail=f"目标主机 '{req.host}' 不在允许列表。仅支持配置文件中的 SFTP/RDS 主机或私有 IP。",
        )

    import time
    import paramiko
    import socket

    start = time.time()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=req.host,
            port=req.port,
            username=req.username,
            password=req.password,
            timeout=8,
            allow_agent=False,
            look_for_keys=False,
        )
        latency_ms = int((time.time() - start) * 1000)
        db.add(AuditLog(
            user_id=admin.id,
            action="platform_test",
            detail=f"测试连接数据分析PC成功: {req.host}:{req.port} ({latency_ms}ms)",
            ip_addr=client_ip,
        ))
        db.commit()
        return {"success": True, "message": f"连接成功（{latency_ms}ms）", "latency_ms": latency_ms}
    except socket.timeout:
        msg = f"连接超时：无法在 8 秒内连上 {req.host}:{req.port}，请检查地址/端口/防火墙"
    except paramiko.AuthenticationException:
        msg = "认证失败：用户名或密码错误"
    except (ConnectionRefusedError, OSError) as e:
        msg = f"网络错误：{e}"
    except Exception as e:  # paramiko.SSHException 等
        msg = f"连接失败：{e}"
    finally:
        client.close()

    db.add(AuditLog(
        user_id=admin.id,
        action="platform_test",
        detail=f"测试连接数据分析PC失败: {req.host}:{req.port} — {msg}",
        status="failed",
        ip_addr=client_ip,
    ))
    db.commit()
    raise HTTPException(status_code=502, detail=msg)
