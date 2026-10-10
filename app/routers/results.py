"""结果路由: 申请导出 / 我的结果 / 下载

普通用户不能直接导出 Windows 平台内的数据，只能「申请导出结果」。
申请后需管理员人工审核，审核通过后结果才出现在「已发布」列表供下载。
"""
import os
import shutil
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, PendingFile, ExportResult, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.review import scan_pending_directory
from app.schemas import PendingFileOut, ExportResultOut

router = APIRouter(prefix="/results", tags=["结果"])


def _user_pending_dir(user_id: int) -> str:
    return os.path.join(settings.fileserver_root, "pending", str(user_id))


def _published_dir(result_id: int) -> str:
    d = os.path.join(settings.fileserver_root, "published", str(result_id))
    os.makedirs(d, exist_ok=True)
    return d


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

扫描当前用户 pending 目录下的新文件，登记为「待审核」的导出申请。
**不会自动审查**，需管理员在 `/admin/pending` 中人工审核。

审核通过后，结果会复制到 published 目录并出现在「已发布」列表。

**错误码**
- `401`：未认证
""")
def request_export(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    pending_dir = _user_pending_dir(user.id)
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
