"""结果路由: 申请导出 / 我的结果 / 下载

普通用户不能直接导出 Windows 平台内的数据，只能把分析结果保存到 Windows 的
待导出目录（C:\\pending\\{用户名}，RDP 中为 RESULTS_DIR），再在平台上
「申请导出结果」。后端经 SFTP 把这些文件回拉到服务器暂存、登记审核；
管理员人工审核通过后结果才出现在「已发布」列表供下载。
"""
import os
import re
import shutil
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, PendingFile, ExportResult, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.review import scan_pending_directory, ALLOWED_EXTENSIONS
from app.schemas import PendingFileOut, ExportResultOut
from app.transfer import list_remote_files, download_file_from_windows

router = APIRouter(prefix="/results", tags=["结果"])

# Windows 文件名白名单（禁止路径分隔符等），防御远端异常文件名穿越本地目录
_SAFE_REMOTE_NAME_RE = re.compile(r"^[^\\/:*?\"<>|]+$")


def _user_pending_dir(user_id: int) -> str:
    return os.path.join(settings.fileserver_root, "pending", str(user_id))


def _published_dir(result_id: int) -> str:
    d = os.path.join(settings.fileserver_root, "published", str(result_id))
    os.makedirs(d, exist_ok=True)
    return d


def pull_user_pending(user: User, local_dir: str) -> list[str]:
    """把 Windows 上 C:\\pending\\{用户名} 的白名单结果文件增量回拉到本地。

    - 只拉审查白名单类型（.csv/.png/.jpg/.out/.txt/.log/.pdf）
    - 同名且大小一致视为未变化，跳过重复下载
    - 返回本次新拉回的本地文件路径列表
    """
    remote_dir = f"{settings.windows_pending_dir}/{user.username}"
    os.makedirs(local_dir, exist_ok=True)

    pulled: list[str] = []
    for name, size in list_remote_files(remote_dir):
        if not _SAFE_REMOTE_NAME_RE.match(name) or name in (".", ".."):
            continue
        if os.path.splitext(name)[1].lower() not in ALLOWED_EXTENSIONS:
            continue
        local_path = os.path.join(local_dir, name)
        if os.path.exists(local_path) and os.path.getsize(local_path) == size:
            continue
        download_file_from_windows(remote_dir, name, local_path)
        pulled.append(local_path)
    return pulled


@router.get("/mine", summary="获取我的结果列表", description="""
**获取当前用户的结果列表**

- `pending`：已提交的导出申请（含待审核/已通过/已拒绝）
- `published`：已通过审核、可下载的结果

**错误码**
- `401`：未认证
""")
def get_my_results(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pending = db.query(PendingFile).filter(
        PendingFile.user_id == user.id
    ).order_by(PendingFile.created_at.desc()).all()

    published = db.query(ExportResult).filter(
        ExportResult.user_id == user.id
    ).order_by(ExportResult.created_at.desc()).all()

    return {
        "pending": [PendingFileOut.model_validate(p) for p in pending],
        "published": [ExportResultOut.model_validate(p) for p in published],
    }


@router.post("/request-export", summary="申请导出结果", description="""
**申请导出结果（普通用户）**

先经 SFTP 从 Windows 云平台的 `C:\\pending\\{用户名}` 待导出目录增量回拉
结果文件（限审查白名单类型），再扫描本地暂存目录，把新文件登记为
「待审核」的导出申请。**不会自动审查**，需管理员在 `/admin/pending` 中
人工审核。审核通过后，结果会复制到 published 目录并出现在「已发布」列表。

**错误码**
- `401`：未认证
- `502`：无法连接 Windows 云平台读取待导出目录
""")
def request_export(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pending_dir = _user_pending_dir(user.id)

    # 先把用户在 Windows 待导出目录里的结果回拉到服务器（目录键为用户名）
    try:
        pull_user_pending(user, pending_dir)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"无法从 Windows 云平台读取待导出文件: {str(e)}",
        )

    files = scan_pending_directory(pending_dir)

    registered = []
    for fpath in files:
        fname = os.path.basename(fpath)
        existing = db.query(PendingFile).filter(
            PendingFile.user_id == user.id,
            PendingFile.file_name == fname,
        ).first()
        if existing:
            continue

        _, ext = os.path.splitext(fname)
        pf = PendingFile(
            user_id=user.id,
            file_name=fname,
            file_path=fpath,
            file_size=os.path.getsize(fpath),
            file_type=ext.lower().lstrip("."),
            status="pending",
        )
        db.add(pf)
        db.flush()
        registered.append({
            "id": pf.id,
            "file_name": fname,
            "status": "pending",
        })

    if registered:
        db.add(AuditLog(
            user_id=user.id,
            action="export_requested",
            detail=f"申请导出 {len(registered)} 个文件: {', '.join(r['file_name'] for r in registered)}",
        ))

    db.commit()

    return {"registered": len(registered), "files": registered}


@router.post("/{result_id}/download", summary="下载已发布结果", description="""
**下载已通过审核的结果文件**

**权限**
- 只能下载自己的结果
- 文件必须已通过管理员审核并发布

**错误码**
- `401`：未认证
- `404`：结果不存在、无权访问或文件已丢失
""")
def download_result(
    result_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    exp = db.query(ExportResult).filter(
        ExportResult.id == result_id,
        ExportResult.user_id == user.id,
    ).first()
    if exp is None:
        raise HTTPException(status_code=404, detail="结果不存在或无权访问")

    # 数据归属 + 有效期校验：过期文件不可下载
    from datetime import datetime as _dt
    if exp.expires_at is not None and exp.expires_at < _dt.utcnow():
        db.add(AuditLog(
            user_id=user.id,
            action="result_download_expired",
            detail=f"下载被拒绝（已过期）：{exp.result_name} (id={result_id})",
            status="failed",
        ))
        db.commit()
        raise HTTPException(status_code=410, detail="文件已过期，无法下载")

    if not os.path.exists(exp.file_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    exp.download_count += 1
    db.add(AuditLog(
        user_id=user.id,
        action="result_download",
        detail=f"下载结果 {exp.result_name} (id={result_id})",
    ))
    db.commit()

    return FileResponse(
        path=exp.file_path,
        filename=exp.result_name,
        media_type="application/octet-stream",
    )
