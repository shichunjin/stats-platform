"""数据集服务：CSV 导入数据库 + 从数据库生成 Excel

将 testData.csv（GBK 编码，中文列名）解析后存入数据库：
- DatasetMeta：列名 + 行数
- DatasetRow：每行以 JSON 字典存储（键为列名，值为字符串）

用户点击「获取数据」时，从数据库读出全部行，用 openpyxl 生成 .xlsx
文件，存放到文件服务器（fileserver）供用户通过 Windows 平台分析使用。
"""
import csv
import os
from typing import Optional

from sqlalchemy.orm import Session

from app.models import DatasetMeta, DatasetRow


def _read_csv_rows(csv_path: str):
    """读取 CSV，返回 (header: list[str], rows: list[list[str]])。

    自动尝试常见中文编码（utf-8-sig → gbk → gb18030 → latin-1）。
    """
    for encoding in ("utf-8-sig", "gbk", "gb18030", "latin-1"):
        try:
            with open(csv_path, "r", encoding=encoding, newline="") as f:
                reader = csv.reader(f)
                header = next(reader)
                rows = [row for row in reader]
            return header, rows
        except (UnicodeDecodeError, StopIteration):
            continue
    raise ValueError(f"无法解析 CSV 文件编码: {csv_path}")


def import_csv_to_db(csv_path: str, db: Session, name: str = "testData") -> DatasetMeta:
    """解析 CSV 并导入数据库，返回数据集元数据。已存在同名数据集时先清空重建。"""
    header, rows = _read_csv_rows(csv_path)

    # 清空同名旧数据（重建）
    old = db.query(DatasetMeta).filter(DatasetMeta.name == name).first()
    if old is not None:
        db.query(DatasetRow).filter(DatasetRow.dataset_id == old.id).delete()
        db.delete(old)
        db.commit()

    meta = DatasetMeta(name=name, column_names=header, total_rows=len(rows))
    db.add(meta)
    db.flush()  # 拿到 meta.id

    # 每行存为 JSON 字典；补齐缺失列（某些行可能列数不足）
    ncols = len(header)
    for idx, row in enumerate(rows):
        padded = row + [""] * (ncols - len(row))
        data = {header[i]: padded[i] for i in range(ncols)}
        db.add(DatasetRow(dataset_id=meta.id, row_index=idx, data=data))

    db.commit()
    db.refresh(meta)
    return meta


def generate_excel_from_db(
    db: Session,
    output_path: str,
    name: str = "testData",
) -> int:
    """从数据库读取数据集并生成 .xlsx，返回写入的行数（不含表头）。"""
    from openpyxl import Workbook

    meta = db.query(DatasetMeta).filter(DatasetMeta.name == name).first()
    if meta is None:
        raise ValueError(f"数据集不存在: {name}")

    header = meta.column_names or []
    rows = (
        db.query(DatasetRow)
        .filter(DatasetRow.dataset_id == meta.id)
        .order_by(DatasetRow.row_index)
        .all()
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title="data")
    ws.append(header)
    for r in rows:
        d = r.data or {}
        ws.append([d.get(col, "") for col in header])
    wb.save(output_path)

    return len(rows)
