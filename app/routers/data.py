"""数据路由：数据集导入 + 获取数据生成 Excel"""
import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, DatasetMeta, AuditLog
from app.auth import get_current_user, require_admin
from app.config import settings
from app.dataset import import_csv_to_db, generate_excel_from_table
from app.transfer import upload_file_to_windows

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

    # SFTP 推送到 Windows 云主机
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
