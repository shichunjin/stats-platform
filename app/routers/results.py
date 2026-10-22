"""结果路由: 申请导出 / 我的结果 / 下载

普通用户不能直接导出 Windows 平台内的数据，只能把分析结果保存到 Windows 的
待导出目录（C:\\pending\\{用户名}，RDP 中为 RESULTS_DIR），再在平台上
「申请导出结果」。后端经 SFTP 把这些文件回拉到服务器暂存，并与原始数据集
（testData.csv）做相似度比对：

- 相似度 ≥ 阈值（默认 60%，可由 EXPORT_REVIEW_SIMILARITY_THRESHOLD 配置）：
  判定疑似原始数据，登记为待审核，管理员人工 approve / reject；
- 相似度低于阈值且通过白名单/敏感信息规则审查（review_result）：免审核，
  系统自动发布，用户立即可下载；
- 图片（png/jpg/jpeg）：免审核自动发布；
- 统计软件原生格式/压缩包/文档（.dta/.rds/.xlsx/.zip/.pdf 等）：一律转人工审核；
- 不允许导出的未知类型：直接拒绝（rejected）并写入审计日志；
- 原始数据基线缺失、二进制伪装文本、编码混淆无法判定时：安全默认转人工审核。

安全修复 A2：导出按扩展名门禁分级，未知类型直接拒绝，杜绝
".dta/.zip 改名 .txt""Base64 编码后导出"等绕过手段。
"""
import os
import re
import shutil
from datetime import datetime, timedelta
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, PendingFile, ExportResult, AuditLog
from app.auth import get_current_user
from app.config import settings
from app.rate_limit import get_client_ip
from app.review import scan_pending_directory, decide_export_review, review_result, file_sha256
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
    """把 Windows 上 C:\\pending\\{用户名} 的结果文件增量回拉到本地。

    - 所有文件类型都允许（是否放行由后续相似度审核决定）；
    - 同名且大小一致视为未变化，跳过重复下载；
    - 返回本次新拉回的本地文件路径列表。
    """
    remote_dir = f"{settings.windows_pending_dir}/{user.username}"
    os.makedirs(local_dir, exist_ok=True)

    pulled: list[str] = []
    for name, size in list_remote_files(remote_dir):
        if not _SAFE_REMOTE_NAME_RE.match(name) or name in (".", ".."):
            continue
        local_path = os.path.join(local_dir, name)
        if os.path.exists(local_path) and os.path.getsize(local_path) == size:
            continue
        download_file_from_windows(remote_dir, name, local_path)
        pulled.append(local_path)
    return pulled


def _auto_publish(db: Session, pf: PendingFile, reason: str) -> ExportResult:
    """免审自动发布：复制到 published 目录并创建可下载记录（30 天有效）。"""
    pub_dir = _published_dir(pf.id)
    pub_path = os.path.join(pub_dir, pf.file_name)
    shutil.copy2(pf.file_path, pub_path)

    exp = ExportResult(
        user_id=pf.user_id,
        pending_file_id=pf.id,
        result_name=pf.file_name,
        file_path=pub_path,
        file_size=pf.file_size,
        expires_at=datetime.utcnow() + timedelta(days=settings.export_publish_valid_days),
    )
    db.add(exp)
    pf.status = "approved"
    pf.review_reason = reason
    pf.reviewed_at = datetime.utcnow()
    db.flush()  # 取得 exp.id，供调用方返回 result_id
    return exp


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
结果文件（**所有类型均可**），再扫描本地暂存目录逐个与原始数据集
（testData.csv）做相似度比对：

- 相似度 **≥ 60%**（`EXPORT_REVIEW_SIMILARITY_THRESHOLD` 可调）：登记为
  「待审核」，管理员在 `/admin/pending` 中人工 approve / reject；
- 文本类文件相似度 **< 60%** 且通过白名单/敏感信息规则审查（review_result）：**免审核自动发布**，
  立即可在「已发布」列表下载（30 天有效）；图片（png/jpg/jpeg）免审自动发布；
- 统计软件原生格式/压缩包/文档（.dta/.rds/.xlsx/.zip/.pdf 等）：无法可靠判定，
  **一律转人工审核**；
- 不允许导出的未知类型：直接**拒绝**（status=rejected）并写入审计日志；
- 原始数据基线缺失、二进制伪装文本、编码混淆无法判定时，安全默认转人工审核。

返回 `registered`（需人工审核数）、`auto_approved`（免审自动通过数）、
`rejected`（拒绝数）。

**错误码**
- `401`：未认证
- `502`：无法连接 Windows 云平台读取待导出目录
""")
def request_export(
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    client_ip = get_client_ip(request)

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

    need_review: list[dict] = []
    auto_approved: list[dict] = []
    rejected: list[dict] = []
    for fpath in files:
        fname = os.path.basename(fpath)
        # 安全修复 B9：以内容哈希判重——仅当「同名 + 同内容 + 状态 pending/approved」
        # 才跳过；同名不同内容（用户改写后重提）生成新申请并接受重新审查；
        # rejected 的同名文件允许重新申请（视为修正后重提）。
        sha = file_sha256(fpath)
        existing = db.query(PendingFile).filter(
            PendingFile.user_id == user.id,
            PendingFile.file_name == fname,
            PendingFile.content_sha == sha,
            PendingFile.status.in_(("pending", "approved")),
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
            content_sha=sha,
        )
        # 唯一索引 ix_pending_files_active 兜底并发重复申请（B9）：
        # 冲突时回滚保存点并跳过本文件，不影响本次请求中其他文件。
        try:
            with db.begin_nested():
                db.add(pf)
                db.flush()  # 取得 pf.id，供发布目录命名与 pending_file_id 关联
        except IntegrityError:
            continue

        decision, reason, _score = decide_export_review(fpath)

        # 安全修复 B8：免审自动发布前必须同时通过白名单/敏感信息规则审查
        # （图片类不包含行级数据，跳过规则审查）
        if decision == "auto" \
                and os.path.splitext(fname)[1].lower() not in (".png", ".jpg", ".jpeg"):
            ok, rule_reason = review_result(fpath)
            if not ok:
                decision = "review"
                reason = f"{rule_reason}；转管理员人工审核"

        if decision == "reject":
            # 安全修复 A2：不允许导出的类型（未知扩展名），登记为拒绝并审计
            pf.status = "rejected"
            pf.review_reason = reason
            db.add(AuditLog(
                user_id=user.id,
                action="export_rejected",
                detail=f"导出被拒绝 {fname} (id={pf.id})：{reason}",
                ip_addr=client_ip,
            ))
            rejected.append({
                "id": pf.id,
                "file_name": fname,
                "status": "rejected",
                "reason": reason,
            })
        elif decision == "auto":
            exp = _auto_publish(db, pf, reason)
            db.add(AuditLog(
                user_id=user.id,
                action="export_auto_approved",
                detail=f"免审核自动通过导出 {fname} (id={pf.id})：{reason}",
                ip_addr=client_ip,
            ))
            auto_approved.append({
                "id": pf.id,
                "file_name": fname,
                "status": "approved",
                "result_id": exp.id,
                "reason": reason,
            })
        else:
            pf.review_reason = reason
            need_review.append({
                "id": pf.id,
                "file_name": fname,
                "status": "pending",
                "reason": reason,
            })

    if need_review:
        db.add(AuditLog(
            user_id=user.id,
            action="export_requested",
            detail=(f"申请导出 {len(need_review)} 个高相似度文件，等待管理员审核: "
                    f"{', '.join(r['file_name'] for r in need_review)}"),
            ip_addr=client_ip,
        ))

    db.commit()

    return {
        "registered": len(need_review),
        "files": need_review,
        "auto_approved": len(auto_approved),
        "auto_files": auto_approved,
        "rejected": len(rejected),
        "rejected_files": rejected,
    }


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
    request: Request,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    client_ip = get_client_ip(request)
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
            ip_addr=client_ip,
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
        ip_addr=client_ip,
    ))
    db.commit()

    return FileResponse(
        path=exp.file_path,
        filename=exp.result_name,
        media_type="application/octet-stream",
    )
