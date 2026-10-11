"""数据集服务：CSV 导入数据库 + 从数据库生成 Excel

将 testData.csv（GBK 编码，中文列名）解析后存入数据库：
- DatasetMeta：列名 + 行数
- DatasetRow：每行以 JSON 字典存储（键为列名，值为字符串）

用户点击「获取数据」时，从数据库读出全部行，用 openpyxl 生成 .xlsx
文件，存放到文件服务器（fileserver）供用户通过 Windows 平台分析使用。
"""
import csv
import os
from datetime import datetime
from typing import Any, Optional

from sqlalchemy import inspect, text
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


def _quote_ident(name: str) -> str:
    """双引号包裹 SQL 标识符（列名/表名），内部双引号转义。"""
    return '"' + name.replace('"', '""') + '"'


def generate_excel_from_table(
    db: Session,
    table_name: str,
    output_path: str,
):
    """从业务宽表（如 create_testdata_table.py 建的 test_data）读取全部列生成 .xlsx。

    - 列名通过 SQLAlchemy inspect 获取（按数据库中列的物理顺序，排除 id 主键）
    - 行按 id 排序，数值列保持数值类型，NULL 写为空单元格
    - 返回 (数据行数, 列数)
    """
    from openpyxl import Workbook

    inspector = inspect(db.bind)
    all_columns = [col["name"] for col in inspector.get_columns(table_name)]
    columns = [c for c in all_columns if c != "id"]
    if not columns:
        raise ValueError(f"数据表 {table_name} 不存在或没有数据列")

    col_sql = ", ".join(_quote_ident(c) for c in columns)
    result = db.execute(
        text(
            f"SELECT {col_sql} FROM {_quote_ident(table_name)} "
            f"ORDER BY {_quote_ident('id')}"
        )
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title="data")
    ws.append(columns)

    row_count = 0
    for row in result:
        ws.append(list(row))  # None 会被 openpyxl 写为空单元格
        row_count += 1

    wb.save(output_path)
    return row_count, len(columns)


# ============================================================
# 列结构智能分析 + 筛选生成（供管理员「数据筛选与生成」页使用）
# ============================================================

# 枚举值数量不超过该阈值时渲染为下拉框
MAX_ENUM_VALUES = 10
# 单次分析最多扫描的数据行数（足够推断枚举与数值范围）
MAX_SAMPLE_ROWS = 5000

# 分析结果进程内缓存：{table_name: (row_count, columns_meta)}
_columns_cache: dict[str, tuple[int, list[dict]]] = {}


def table_columns(db: Session, table_name: str) -> list[str]:
    """返回数据表的物理列名（按数据库中的顺序，排除 id）。"""
    inspector = inspect(db.bind)
    all_columns = [col["name"] for col in inspector.get_columns(table_name)]
    return [c for c in all_columns if c != "id"]


def analyze_table_columns(db: Session, table_name: str, use_cache: bool = True) -> list[dict]:
    """分析宽表列结构，为前端智能筛选提供元数据。

    返回每列：
      - name:    列名
      - type:    int / float / text
      - control: select（枚举值少）/ range（数值）/ input（文本模糊）
      - options: select 的枚举值（保序去重、数值按数值排序）
      - min/max: range 的数值范围
    """
    # 行数用于缓存失效判断
    total = db.execute(
        text(f"SELECT COUNT(*) FROM {_quote_ident(table_name)}")
    ).scalar() or 0

    if use_cache:
        cached = _columns_cache.get(table_name)
        if cached and cached[0] == total:
            return cached[1]

    columns = table_columns(db, table_name)
    if not columns:
        raise ValueError(f"数据表 {table_name} 不存在或没有数据列")

    col_sql = ", ".join(_quote_ident(c) for c in columns)
    result = db.execute(
        text(
            f"SELECT {col_sql} FROM {_quote_ident(table_name)} "
            f"LIMIT {int(MAX_SAMPLE_ROWS)}"
        )
    )
    rows = result.fetchall()

    meta: list[dict] = []
    for idx, col in enumerate(columns):
        values = [r[idx] for r in rows if r[idx] is not None and r[idx] != ""]
        col_info: dict[str, Any] = {"name": col}

        # 1. 判断基础类型（全部能转 float 视为数值；全为整数视为 int）
        is_float = _all_float(values)
        if is_float:
            nums = [float(v) for v in values]
            is_int = all(float(v).is_integer() for v in nums)
            col_info["type"] = "int" if is_int else "float"
            distinct = sorted(set(nums))
            # 枚举少（且非唯一标识）→ 下拉框，否则数值区间
            if 0 < len(distinct) <= MAX_ENUM_VALUES:
                col_info["control"] = "select"
                col_info["options"] = [int(n) if float(n).is_integer() else n for n in distinct]
            else:
                col_info["control"] = "range"
                col_info["min"] = min(nums)
                col_info["max"] = max(nums)
        else:
            # 文本列：去重值少 → 下拉，否则模糊输入
            col_info["type"] = "text"
            distinct = list(dict.fromkeys(str(v) for v in values))
            if 0 < len(distinct) <= MAX_ENUM_VALUES:
                col_info["control"] = "select"
                col_info["options"] = distinct
            else:
                col_info["control"] = "input"

        meta.append(col_info)

    _columns_cache[table_name] = (total, meta)
    return meta


def _all_float(values: list) -> bool:
    """样本值是否全部可转换为数值。"""
    if not values:
        return False
    for v in values:
        try:
            float(v)
        except (TypeError, ValueError):
            return False
    return True


def _build_where_clause(
    filters: dict[str, Any],
    valid_columns: set[str],
) -> tuple[str, dict[str, Any]]:
    """把前端筛选条件转为参数化 WHERE 子句，返回 (sql, params)。

    支持的取值形式：
      - 标量数字/字符串        → 数值等值 / 文本 ILIKE 模糊
      - [min, max]（可含 null）→ 数值区间
      - 列表（枚举多选）        → IN
    列名先做白名单校验，防止 SQL 注入。
    """
    clauses: list[str] = []
    params: dict[str, Any] = {}
    seq = 0

    for col, val in filters.items():
        if col not in valid_columns or val is None or val == "":
            continue
        ident = _quote_ident(col)
        key = f"f{seq}"
        seq += 1

        # 区间：两元素数组
        if isinstance(val, (list, tuple)) and len(val) == 2 and all(
            v is None or isinstance(v, (int, float)) for v in val
        ):
            low, high = val
            if low is not None:
                clauses.append(f"{ident} >= :{key}_lo")
                params[f"{key}_lo"] = low
            if high is not None:
                clauses.append(f"{ident} <= :{key}_hi")
                params[f"{key}_hi"] = high
            continue

        # 枚举多选：纯列表
        if isinstance(val, (list, tuple)):
            if not val:
                continue
            placeholders = ", ".join(f":{key}_{i}" for i in range(len(val)))
            clauses.append(f"{ident} IN ({placeholders})")
            for i, v in enumerate(val):
                params[f"{key}_{i}"] = v
            continue

        # 数值标量 → 等值；字符串 → 模糊（LOWER 写法兼容 PostgreSQL / SQLite）
        if isinstance(val, (int, float)):
            clauses.append(f"{ident} = :{key}")
            params[key] = val
        else:
            clauses.append(f"LOWER(CAST({ident} AS TEXT)) LIKE LOWER(:{key})")
            params[key] = f"%{val}%"

    where_sql = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return where_sql, params


def generate_filtered_excel_from_table(
    db: Session,
    table_name: str,
    output_path: str,
    filters: Optional[dict[str, Any]] = None,
):
    """按筛选条件从宽表查询数据生成 .xlsx，返回 (数据行数, 列数)。

    - 列名按物理顺序，排除 id 主键
    - 筛选条件做列名白名单校验 + 参数绑定
    - 空结果也会生成仅含表头的文件
    """
    from openpyxl import Workbook

    columns = table_columns(db, table_name)
    if not columns:
        raise ValueError(f"数据表 {table_name} 不存在或没有数据列")

    valid = set(columns)
    where_sql, params = _build_where_clause(filters or {}, valid)

    col_sql = ", ".join(_quote_ident(c) for c in columns)
    result = db.execute(
        text(
            f"SELECT {col_sql} FROM {_quote_ident(table_name)}"
            f"{where_sql} ORDER BY {_quote_ident('id')}"
        ),
        params,
    )

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    wb = Workbook(write_only=True)
    ws = wb.create_sheet(title="data")
    ws.append(columns)

    row_count = 0
    for row in result:
        ws.append(list(row))
        row_count += 1

    wb.save(output_path)
    return row_count, len(columns)


def timestamp_filename(base: str = "testData", ext: str = "xlsx") -> str:
    """生成 {base}_{YYYYMMDD_HHmmss}.{ext} 文件名，避免覆盖历史文件。"""
    return f"{base}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.{ext}"
