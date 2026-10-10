"""数据路由：数据集导入 + 获取数据生成 Excel"""
import os
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import User, DatasetMeta, AuditLog
from app.auth import get_current_user, require_admin
from app.config import settings
from app.dataset import import_csv_to_db, generate_excel_from_table

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


@router.post("/fetch", summary="获取数据（生成 Excel 到文件服务器）", description="""
**从业务宽表 test_data 读取数据并生成 Excel 文件，存放到文件服务器供用户分析**

- 数据来源：`create_testdata_table.py` 建立的业务宽表（默认表名 `test_data`，可用环境变量覆盖）
- 所有登录用户获取同一份完整数据（数据权限差异暂不切分此数据集）
- 生成的 `.xlsx` 存放到 `fileserver_root/data/{dataset_name}.xlsx`
- 用户通过 Windows 平台（RDP）访问该文件进行分析

**错误码**
- `401`：未认证
- `404`：业务数据表不存在或没有数据列（需先运行 create_testdata_table.py）
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

    db.add(AuditLog(
        user_id=user.id,
        action="data_fetch",
        detail=f"获取数据 {settings.dataset_name}.xlsx: {rows} 行, {columns} 列（来源表 {settings.testdata_table}）",
    ))
    db.commit()

    return {
        "filename": f"{settings.dataset_name}.xlsx",
        "rows": rows,
        "columns": columns,
        "path": out_path,
    }
