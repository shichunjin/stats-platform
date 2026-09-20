"""结果路由: GET /results/mine, POST /results/{id}/download, POST /results/scan"""
import os
import shutil
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, PendingFile, ExportResult, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.review import review_result, scan_pending_directory
from app.schemas import PendingFileOut, ExportResultOut

router = APIRouter(prefix="/results", tags=["结果"])


def _user_pending_dir(user_id: int) -> str:
    return os.path.join(settings.fileserver_root, "pending", str(user_id))


def _user_workspace_dir(user_id: int) -> str:
    return os.path.join(settings.fileserver_root, "workspace", str(user_id))


def _published_dir(result_id: int) -> str:
    d = os.path.join(settings.fileserver_root, "published", str(result_id))
    os.makedirs(d, exist_ok=True)
    return d


@router.get("/mine", summary="获取我的结果列表", description="""
**获取当前用户的结果列表**

返回两部分数据：
- `pending`：待审查的文件列表
- `published`：已通过审查可下载的结果列表

**权限**
- 只能查看自己的结果，不能查看其他用户的

**错误码**
- `401`：未认证
""")
def get_my_results(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """获取我的待审查文件和已发布结果"""
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


@router.post("/scan", summary="扫描审查结果文件", description="""
**扫描 pending 目录并自动审查结果文件**

**审查规则**
- **文件类型白名单**：`.csv` / `.png` / `.jpg` / `.out` / `.txt` / `.log` / `.pdf`
- **CSV 字段白名单**：只允许聚合/统计结果列名（如 `mean` / `std` / `estimate` / `p_value` 等）
- **敏感字段拒绝**：列名命中 `id` / `name` / `phone` / `email` 等敏感字段直接拒绝
- **敏感数据正则**：单元格内容匹配手机号、身份证号、邮箱等正则即拒绝
- **行数上限**：CSV 数据行数超过 200 行拒绝（疑似导出原始明细数据）
- **列数上限**：CSV 列数超过 30 列拒绝（疑似导出原始宽表）

**业务流程**
1. 扫描用户 pending 目录下的所有文件
2. 对未记录的新文件执行自动审查
3. 通过审查的文件复制到 published 目录，创建可下载的导出记录
4. 未通过的文件标记为 rejected
5. 所有操作记录审计日志

**错误码**
- `401`：未认证
""")
def scan_pending(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """扫描 pending 目录，审查新文件"""
    pending_dir = _user_pending_dir(user.id)
    files = scan_pending_directory(pending_dir)

    results = []
    scanned = 0
    for fpath in files:
        fname = os.path.basename(fpath)
        # 检查是否已记录（任何状态都已记录的文件都跳过）
        existing = db.query(PendingFile).filter(
            PendingFile.user_id == user.id,
            PendingFile.file_name == fname,
        ).first()
        if existing:
            continue

        scanned += 1
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
        db.commit()
        db.refresh(pf)

        # 执行审查
        ok, reason = review_result(fpath, user)
        pf.status = "approved" if ok else "rejected"
        pf.review_reason = reason
        pf.reviewed_by = user.id  # 自动审查
        db.commit()

        if ok:
            # 复制到 published 目录
            pub_dir = _published_dir(pf.id)
            pub_path = os.path.join(pub_dir, fname)
            shutil.copy2(fpath, pub_path)

            exp = ExportResult(
                user_id=user.id,
                pending_file_id=pf.id,
                result_name=fname,
                file_path=pub_path,
                file_size=pf.file_size,
            )
            db.add(exp)
            db.add(AuditLog(
                user_id=user.id,
                action="result_approved",
                detail=f"文件 {fname} 审查通过: {reason}",
            ))
        else:
            db.add(AuditLog(
                user_id=user.id,
                action="result_rejected",
                detail=f"文件 {fname} 审查失败: {reason}",
            ))
        db.commit()

        results.append({
            "file_name": fname,
            "status": pf.status,
            "reason": reason,
        })

    return {"scanned": scanned, "results": results}


@router.post("/{result_id}/download", summary="下载已发布结果", description="""
**下载已通过审查的结果文件**

**权限**
- 只能下载自己的结果，不能下载其他用户的
- 文件必须已通过审查并发布

**业务流程**
1. 校验用户对结果的所有权
2. 递增下载次数
3. 记录审计日志
4. 返回文件流

**错误码**
- `401`：未认证
- `404`：结果不存在、无权访问或文件已丢失
""")
def download_result(
    result_id: int,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """下载已发布的结果文件"""
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
