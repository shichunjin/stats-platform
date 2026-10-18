"""数据路由：数据集导入 + 获取数据生成 Excel + 列结构分析 + 按筛选生成"""
import os
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, AuditLog, Message, DataApply
from app.auth import get_current_user, require_admin
from app.config import settings
from app.rate_limit import get_client_ip
from app.dataset import (
    import_csv_to_db,
    generate_filtered_excel_from_table,
    analyze_table_columns,
    timestamp_filename,
)
from app.transfer import upload_file_to_windows
from app.schemas import FilteredDataGenerateRequest

router = APIRouter(prefix="/data", tags=["数据"])


@router.post("/import", summary="导入数据集到数据库（管理员）", description="""
**将原始 CSV 数据集导入数据库（仅管理员）**

- 默认读取 `settings.dataset_csv_path` 指向的 CSV 文件
- 解析后存入 `dataset_meta`（列名/行数）和 `dataset_rows`（行数据）
- 重复导入会清空同名旧数据并重建

**错误码**
- `401`：未认证
- `403`：非管理员
""")
def import_dataset(
    request: Request,
    csv_path: str | None = None,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    client_ip = get_client_ip(request)
    path = csv_path or settings.dataset_csv_path

    # 安全修复 B4：限制可导入的路径，防止本地文件读取（LFI）
    # 允许的路径：1) 配置文件中的 dataset_csv_path；2) fileserver_root 下的 csv 文件
    allowed_base = os.path.realpath(settings.dataset_csv_path)
    allowed_root = os.path.realpath(settings.fileserver_root)
    resolved = os.path.realpath(path)

    if resolved != allowed_base and not resolved.startswith(allowed_root + os.sep):
        db.add(AuditLog(
            user_id=admin.id,
            action="dataset_import",
            detail=f"导入被拒绝（路径不允许）: {path}",
            status="failed",
            ip_addr=client_ip,
        ))
        db.commit()
        raise HTTPException(
            status_code=400,
            detail="导入路径不允许。仅支持配置文件指定的数据集路径或 fileserver_root 下的 CSV 文件。",
        )

    if not os.path.exists(resolved):
        raise HTTPException(status_code=404, detail=f"CSV 文件不存在: {path}")

    meta = import_csv_to_db(resolved, db, name=settings.dataset_name)

    db.add(AuditLog(
        user_id=admin.id,
        action="dataset_import",
        detail=f"导入数据集 {meta.name}: {meta.total_rows} 行, {len(meta.column_names or [])} 列",
        ip_addr=client_ip,
    ))
    db.commit()

    return {
        "name": meta.name,
        "total_rows": meta.total_rows,
        "columns": len(meta.column_names or []),
    }


@router.post("/fetch", summary="获取数据（已停用）", description="""
**该接口已停用（安全加固）**

数据获取必须走「申请 → 管理员按筛选生成」流程，禁止任何用户直接拉取全量宽表。

**错误码**
- `403`：接口已停用，请通过数据申请由管理员生成
""")
def fetch_data(
    user: User = Depends(get_current_user),
):
    # 安全修复 A1：原实现允许任意登录用户一键拉取全量业务宽表，
    # 绕过申请与数据权限（scopes）。保留路由以显式拒绝旧客户端。
    raise HTTPException(
        status_code=403,
        detail="直接获取数据已停用，请通过「申请获取数据」由管理员生成",
    )


@router.get("/columns", summary="获取数据表列结构（智能筛选控件元数据，管理员）", description="""
**分析 test_data 宽表的列结构，供前端「数据筛选与生成」页智能渲染控件**

- 枚举值少（≤10）的列 → `control=select`，返回 `options`
- 数值列 → `control=range`，返回 `min/max`
- 文本列 → `control=input`（模糊搜索）
- 结果按行数缓存，数据变化后自动刷新
""")
def get_columns(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    try:
        return analyze_table_columns(db, settings.testdata_table)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"分析列结构失败: {str(e)}")


@router.post("/generate", summary="按筛选条件生成数据并推送给目标用户（管理员）", description="""
**管理员在数据筛选页确认生成：**

- 按 `filters` 从 test_data 宽表筛选数据生成 `.xlsx`
- 文件命名 `{原始名}_{YYYYMMDD_HHmmss}.xlsx`，不覆盖历史文件
- 通过 SFTP 写入目标用户在 Windows 云平台的个人工作区目录（W: 盘）
- 自动给目标用户发送站内消息；若带 `apply_id` 则把申请置为「已完成」
- 失败返回 500/502，前端可在错误日志中手动重试

**filters 取值形式**
- 枚举下拉：`{"sex33": 1}`（等值）或 `{"sex33": [1, 2]}`（多选 IN）
- 数值区间：`{"age33": [20, 35]}`（端点可为 null）
- 文本模糊：`{"姓名": "张"}`
""")
def generate_filtered(
    payload: FilteredDataGenerateRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    client_ip = get_client_ip(request)
    # 校验目标用户
    target = db.query(User).filter(User.id == payload.target_user_id).first()
    if target is None:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    # 安全修复 B7：scopes 权限消费——目标用户未被分配数据权限时拒绝生成
    # （无 scope 拒绝取数），防止「申请后权限被吊销」仍拿到数据。
    if not target.scopes:
        db.add(AuditLog(
            user_id=admin.id,
            action="data_generate",
            detail=f"生成被拒绝（目标用户 {target.username}(id={target.id}) 未分配数据权限 scopes）",
            status="failed",
            ip_addr=client_ip,
        ))
        db.commit()
        raise HTTPException(
            status_code=400,
            detail=f"用户 {target.username} 尚未被分配数据权限（scopes），请先在「用户数据权限」页面分配后再生成",
        )

    # 安全修复 A1/B6：生成必须绑定有效申请，且申请属于目标用户、处于可处理状态。
    # with_for_update 行锁防止并发重复生成/重复置完成。
    if not payload.apply_id:
        raise HTTPException(
            status_code=400,
            detail="生成数据必须关联数据申请，请从「待处理申请」页面发起",
        )
    apply_obj = db.query(DataApply).filter(
        DataApply.id == payload.apply_id,
    ).with_for_update().first()
    if apply_obj is None or apply_obj.user_id != payload.target_user_id:
        raise HTTPException(
            status_code=400,
            detail="申请不存在、已处理或不属于目标用户",
        )
    if apply_obj.status not in ("pending", "processing"):
        raise HTTPException(
            status_code=400,
            detail=f"申请当前状态为「{apply_obj.status}」，不可生成",
        )

    # 文件名：前端指定或按时间戳自动生成
    # 安全修复 B5：规范化文件名，防止路径穿越（如 ../../etc/passwd）
    import re
    filename = payload.filename or timestamp_filename(settings.dataset_name)
    # 仅保留安全字符：字母/数字/下划线/连字符/点/中文，拒绝路径分隔符
    filename = re.sub(r'[^\w\-.一-龥]', '_', filename)
    # 去掉开头的点（防隐藏文件/目录穿越）和连续点
    filename = re.sub(r'^\.+', '', filename)
    filename = re.sub(r'\.{2,}', '.', filename)
    if not filename:
        filename = timestamp_filename(settings.dataset_name)
    if not filename.lower().endswith(".xlsx"):
        filename += ".xlsx"

    out_dir = os.path.join(settings.fileserver_root, "generated", str(target.id))
    out_path = os.path.join(out_dir, filename)

    # 1. 按筛选生成 Excel
    try:
        rows, columns = generate_filtered_excel_from_table(
            db, settings.testdata_table, out_path, payload.filters
        )
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成 Excel 失败: {str(e)}")

    # 2. 推送到目标用户的 Windows 个人工作区（W: 盘根目录），投递后立即锁定为本人私有
    remote_dir = f"{settings.windows_workspace_dir}/{target.username}"
    try:
        win_path = upload_file_to_windows(
            out_path, remote_dir=remote_dir, remote_name=filename,
            lock_owner=target.username,
        )
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Excel 已生成，但推送到 Windows 云平台失败: {str(e)}",
        )

    # 3. 关联申请置为完成（apply_obj 已在上方校验并锁定）
    from datetime import datetime
    apply_obj.status = "completed"
    apply_obj.finished_at = datetime.utcnow()
    apply_obj.processed_by = admin.id

    # 4. 站内消息通知目标用户
    db.add(Message(
        user_id=target.id,
        title="您申请的数据已生成",
        content=f"数据文件 {filename}（{rows} 行 × {columns} 列）已生成，"
                f"请连接 Windows 分析平台，在 W: 盘打开使用。",
        msg_type="success",
        link="/user/my-requests",
    ))

    db.add(AuditLog(
        user_id=admin.id,
        action="data_generate",
        detail=f"为用户 {target.username}(id={target.id}) 生成 {filename}: "
               f"{rows} 行, {columns} 列，筛选 {len(payload.filters)} 项，推送至 {win_path}",
        ip_addr=client_ip,
    ))
    db.commit()

    return {
        "filename": filename,
        "rows": rows,
        "columns": columns,
        "target_user": target.display_name or target.username,
        "windows_path": win_path,
        "local_path": out_path,
    }
