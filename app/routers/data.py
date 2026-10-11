"""数据路由：数据集导入 + 获取数据生成 Excel + 列结构分析 + 按筛选生成"""
import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, AuditLog, Message, DataApply
from app.auth import get_current_user, require_admin
from app.config import settings
from app.dataset import (
    import_csv_to_db,
    generate_excel_from_table,
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
    csv_path: str | None = None,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    path = csv_path or settings.dataset_csv_path
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail=f"CSV 文件不存在: {path}")

    meta = import_csv_to_db(path, db, name=settings.dataset_name)

    db.add(AuditLog(
        user_id=admin.id,
        action="dataset_import",
        detail=f"导入数据集 {meta.name}: {meta.total_rows} 行, {len(meta.column_names or [])} 列",
    ))
    db.commit()

    return {
        "name": meta.name,
        "total_rows": meta.total_rows,
        "columns": len(meta.column_names or []),
    }


@router.post("/fetch", summary="获取数据（生成 Excel 并推送到 Windows 云平台）", description="""
**从业务宽表 test_data 读取数据生成 Excel，并通过 SFTP 推送到 Windows 云主机 C:\\StatsData**

- 数据来源：`create_testdata_table.py` 建立的业务宽表（默认表名 `test_data`，可用环境变量覆盖）
- 所有登录用户获取同一份完整数据（数据权限差异暂不切分此数据集）
- 生成的 `.xlsx` 先落到 `fileserver_root/data/`，再 SFTP 上传到 Windows
- 用户连接 Windows 平台后，在 **Z: 盘**即可直接打开使用

**错误码**
- `401`：未认证
- `404`：业务数据表不存在或没有数据列（需先运行 create_testdata_table.py）
- `502`：SFTP 推送到 Windows 失败（检查 OpenSSH、安全组 22 端口、私钥配置）
""")
def fetch_data(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    out_dir = os.path.join(settings.fileserver_root, "data")
    out_path = os.path.join(out_dir, f"{settings.dataset_name}.xlsx")

    try:
        rows, columns = generate_excel_from_table(db, settings.testdata_table, out_path)
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"生成 Excel 失败: {str(e)}")

    # SFTP 推送到 Windows 云主机（公共数据目录，Z: 盘）
    try:
        win_path = upload_file_to_windows(out_path)
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Excel 已生成，但推送到 Windows 云平台失败: {str(e)}",
        )

    db.add(AuditLog(
        user_id=user.id,
        action="data_fetch",
        detail=f"获取数据 {settings.dataset_name}.xlsx: {rows} 行, {columns} 列，"
               f"已推送到 Windows {win_path}",
    ))
    db.commit()

    return {
        "filename": f"{settings.dataset_name}.xlsx",
        "rows": rows,
        "columns": columns,
        "local_path": out_path,
        "windows_path": win_path,
    }


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
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
):
    # 校验目标用户
    target = db.query(User).filter(User.id == payload.target_user_id).first()
    if target is None:
        raise HTTPException(status_code=404, detail="目标用户不存在")

    # 文件名：前端指定或按时间戳自动生成
    filename = payload.filename or timestamp_filename(settings.dataset_name)
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

    # 2. 推送到目标用户的 Windows 个人工作区（W: 盘根目录）
    remote_dir = f"{settings.windows_workspace_dir}/{target.username}"
    try:
        win_path = upload_file_to_windows(out_path, remote_dir=remote_dir, remote_name=filename)
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"Excel 已生成，但推送到 Windows 云平台失败: {str(e)}",
        )

    # 3. 关联申请置为完成
    apply_obj = None
    if payload.apply_id:
        apply_obj = db.query(DataApply).filter(DataApply.id == payload.apply_id).first()
        if apply_obj and apply_obj.status != "completed":
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
