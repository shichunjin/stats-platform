"""将 testData.csv 分析后建表并导入 PostgreSQL

功能：
1. 读取 CSV，自动分析每列数据类型（int / float / text）
2. 生成并执行 CREATE TABLE DDL（列名保留中文，用双引号包裹）
3. 批量导入 1074 行数据，空字符串转为 NULL

用法（在 Linux 服务器 stats-platform 目录下）：
    source venv/bin/activate
    python create_testdata_table.py

    # 指定 CSV 路径
    python create_testdata_table.py --csv /path/to/testData.csv

    # 指定表名
    python create_testdata_table.py --table my_study_data
"""
import argparse
import csv
import os
import sys
import re
from typing import List, Tuple

# 确保能 import app 包
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.config import settings
from app.database import engine

from sqlalchemy import text


# 日期格式 M/D/YYYY 的正则
_DATE_RE = re.compile(r'^\d{1,2}/\d{1,2}/\d{4}$')


def read_csv(csv_path: str) -> Tuple[List[str], List[List[str]]]:
    """读取 CSV，自动尝试编码。"""
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


def detect_column_types(header: List[str], rows: List[List[str]]) -> List[str]:
    """检测每列数据类型，返回 ['int'|'float'|'text'|'empty', ...]"""
    types = []
    for j, col in enumerate(header):
        vals = []
        for row in rows:
            if j < len(row):
                v = row[j].strip()
                if v != "":
                    vals.append(v)
        if not vals:
            types.append("empty")
            continue

        # 整数
        all_int = True
        for v in vals:
            if not (v.lstrip("-").isdigit()):
                all_int = False
                break
        if all_int:
            types.append("int")
            continue

        # 浮点
        all_float = True
        for v in vals:
            try:
                float(v)
            except ValueError:
                all_float = False
                break
        if all_float:
            types.append("float")
            continue

        # 日期（M/D/YYYY）→ 仍存为 text，避免格式转换风险
        types.append("text")

    return types


def quote_col(name: str) -> str:
    """PostgreSQL 列名用双引号包裹，内部双引号转义。"""
    return '"' + name.replace('"', '""') + '"'


def pg_type(col_type: str) -> str:
    """列类型 → PostgreSQL 类型。"""
    if col_type == "int":
        return "INTEGER"
    if col_type == "float":
        return "DOUBLE PRECISION"
    return "TEXT"  # text 和 empty 都用 TEXT


def build_create_table(table_name: str, header: List[str], col_types: List[str]) -> str:
    """生成 CREATE TABLE 语句。"""
    lines = [f'CREATE TABLE IF NOT EXISTS "{table_name}" (']
    lines.append('  "id" SERIAL PRIMARY KEY,')
    col_defs = []
    for name, ctype in zip(header, col_types):
        col_defs.append(f"  {quote_col(name)} {pg_type(ctype)}")
    lines.append(",\n".join(col_defs))
    lines.append(");")
    return "\n".join(lines)


def convert_value(val: str, col_type: str):
    """将字符串值转为对应 Python 类型；空字符串返回 None。"""
    v = val.strip()
    if v == "":
        return None
    if col_type == "int":
        try:
            return int(v)
        except ValueError:
            return v  # 兜底存文本
    if col_type == "float":
        try:
            return float(v)
        except ValueError:
            return v
    return v


def main():
    parser = argparse.ArgumentParser(description="分析 CSV 并建表导入 PostgreSQL")
    parser.add_argument("--csv", default=settings.dataset_csv_path, help="CSV 路径")
    parser.add_argument("--table", default="test_data", help="数据库表名")
    parser.add_argument("--drop", action="store_true", help="导入前删除已存在的同名表")
    args = parser.parse_args()

    csv_path = args.csv
    table_name = args.table

    if not os.path.exists(csv_path):
        print(f"[错误] CSV 文件不存在: {csv_path}")
        sys.exit(1)

    # 1. 读取 CSV
    print(f"[1/4] 读取 CSV: {csv_path}")
    header, rows = read_csv(csv_path)
    print(f"      列数: {len(header)}, 行数: {len(rows)}")

    # 2. 检测列类型
    print("[2/4] 分析列数据类型...")
    col_types = detect_column_types(header, rows)
    from collections import Counter
    type_dist = Counter(col_types)
    print(f"      类型分布: {dict(type_dist)}")

    # 3. 建表
    print(f"[3/4] 建表: {table_name}")
    if args.drop:
        with engine.begin() as conn:
            conn.execute(text(f'DROP TABLE IF EXISTS "{table_name}"'))
        print(f"      已删除旧表 {table_name}")

    ddl = build_create_table(table_name, header, col_types)
    with engine.begin() as conn:
        conn.execute(text(ddl))
    print(f"      表 {table_name} 创建完成（含 {len(header)} 列 + id 主键）")

    # 4. 导入数据
    print(f"[4/4] 导入数据（共 {len(rows)} 行）...")
    placeholders = ", ".join([f":c{i}" for i in range(len(header))])
    col_list = ", ".join([quote_col(c) for c in header])
    insert_sql = f'INSERT INTO "{table_name}" ({col_list}) VALUES ({placeholders})'

    # 分批插入，每批 500 行
    batch_size = 500
    total = 0
    with engine.begin() as conn:
        for start in range(0, len(rows), batch_size):
            batch = rows[start:start + batch_size]
            params_list = []
            for row in batch:
                params = {}
                for i, (ctype) in enumerate(col_types):
                    val = row[i] if i < len(row) else ""
                    params[f"c{i}"] = convert_value(val, ctype)
                params_list.append(params)
            conn.execute(text(insert_sql), params_list)
            total += len(batch)
            print(f"      已导入 {total}/{len(rows)} 行")

    print()
    print(f"[成功] 数据导入完成！")
    print(f"        表名: {table_name}")
    print(f"        总行数: {total}")
    print(f"        总列数: {len(header)}")
    print(f"        整数列: {type_dist.get('int', 0)}")
    print(f"        浮点列: {type_dist.get('float', 0)}")
    print(f"        文本列: {type_dist.get('text', 0)}")
    print(f"        空列: {type_dist.get('empty', 0)}")


if __name__ == "__main__":
    main()
