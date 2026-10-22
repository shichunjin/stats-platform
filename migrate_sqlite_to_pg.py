"""SQLite → PostgreSQL 一次性数据迁移（走 ORM 层，不依赖 schema.sql）

只迁移 app/models.py 里定义的业务表：
    users / sessions / pending_files / export_results /
    audit_logs / data_applies / messages / platform_config
（dataset_meta / dataset_rows 是已被宽表方案取代的死代码表，默认跳过）

分析宽表 test_data 不在 ORM 里，迁移完成后用 create_testdata_table.py 从 CSV 重建：
    venv/bin/python create_testdata_table.py --csv <路径> --table test_data --drop
这样能顺带修掉 SQLite 下 SERIAL 不生效导致的 id 为空、导出 Excel 行序错乱问题。

用法（在 stats-platform 目录下，目标 PG 库已创建）：
    venv/bin/python migrate_sqlite_to_pg.py \
        --sqlite ./stats_platform.db \
        --pg-url "postgresql+psycopg2://stats:密码@127.0.0.1:5432/stats_platform" \
        --force

参数：
    --sqlite   源 SQLite 文件路径，默认 ./stats_platform.db
    --pg-url   目标 PostgreSQL 连接串（必填）
    --force    导入前清空目标表数据（表结构保留）
    --dry-run  只打印将要迁移的行数，不写库
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sqlalchemy import create_engine, inspect, text
from sqlalchemy.orm import sessionmaker

# 导入模型以完成 Base.metadata 注册（同时拿到全部 ORM 表）
from app.database import Base
from app.models import (  # noqa: F401  仅为了注册到 Base.metadata
    User, Session, PendingFile, ExportResult, AuditLog,
    DataApply, Message, PlatformConfig,
)

# 迁移顺序：被引用的表在前，避免外键约束（PG 默认不延迟检查）
MIGRATE_ORDER = [
    User, Session, PendingFile, ExportResult, AuditLog,
    DataApply, Message, PlatformConfig,
]


def build_sessions(sqlite_path: str, pg_url: str):
    """建立源（SQLite）和目标（PG）两套 engine + session。"""
    src_engine = create_engine(
        f"sqlite:///{os.path.abspath(sqlite_path)}",
        connect_args={"check_same_thread": False},
    )
    dst_engine = create_engine(pg_url, pool_pre_ping=True)
    return (
        sessionmaker(bind=src_engine, autoflush=False),
        sessionmaker(bind=dst_engine, autoflush=False),
        src_engine,
        dst_engine,
    )


def table_dicts(session, model):
    """把一张 ORM 表读成 dict 列表，保留主键 id。"""
    rows = session.query(model).all()
    cols = model.__table__.columns.keys()
    return [{c: getattr(r, c) for c in cols} for r in rows]


def reset_sequence(dst_session, model):
    """PG 序列对齐到当前最大 id，防止后续插入主键冲突。"""
    table = model.__tablename__
    pk_cols = list(model.__table__.primary_key.columns)
    # platform_config 的主键是字符串 key，没有序列
    if len(pk_cols) != 1 or pk_cols[0].name != "id":
        return
    dst_session.execute(text(
        f'SELECT setval(pg_get_serial_sequence(\'"{table}"\', \'id\'), '
        f'COALESCE((SELECT MAX(id) FROM "{table}"), 1), '
        f'(SELECT COUNT(*) FROM "{table}") > 0)'
    ))


def main():
    parser = argparse.ArgumentParser(description="SQLite → PostgreSQL 业务表迁移")
    parser.add_argument("--sqlite", default="./stats_platform.db", help="源 SQLite 文件")
    parser.add_argument("--pg-url", required=True, help="目标 PG 连接串")
    parser.add_argument("--force", action="store_true", help="导入前清空目标表数据")
    parser.add_argument("--dry-run", action="store_true", help="只统计行数，不写库")
    args = parser.parse_args()

    if not os.path.exists(args.sqlite):
        print(f"[错误] SQLite 文件不存在: {args.sqlite}")
        sys.exit(1)

    SrcSession, DstSession, src_engine, dst_engine = build_sessions(
        args.sqlite, args.pg_url
    )

    # 1. 源库现有表
    src_tables = set(inspect(src_engine).get_table_names())
    print(f"[1/4] 源库表: {sorted(src_tables)}")

    # 2. 目标库建表（按 ORM 定义，类型精确；已存在则跳过）
    if not args.dry_run:
        print("[2/4] 在目标 PG 创建 ORM 表结构（IF NOT EXISTS 语义）...")
        Base.metadata.create_all(dst_engine, checkfirst=True)
    else:
        print("[2/4] dry-run：跳过建表")

    # 3. 逐表导数据
    print("[3/4] 迁移数据...")
    src_sess = SrcSession()
    dst_sess = DstSession()
    total = 0
    try:
        for model in MIGRATE_ORDER:
            name = model.__tablename__
            if name not in src_tables:
                print(f"      - {name}: 源库无此表，跳过")
                continue

            dicts = table_dicts(src_sess, model)
            if not dicts:
                print(f"      - {name}: 0 行")
                continue

            if args.dry_run:
                print(f"      - {name}: {len(dicts)} 行（dry-run 未写入）")
                total += len(dicts)
                continue

            if args.force:
                dst_sess.execute(text(f'DELETE FROM "{name}"'))

            dst_sess.execute(model.__table__.insert(), dicts)
            dst_sess.commit()
            reset_sequence(dst_sess, model)
            dst_sess.commit()

            print(f"      - {name}: {len(dicts)} 行 ✓")
            total += len(dicts)
    except Exception:
        dst_sess.rollback()
        raise
    finally:
        src_sess.close()
        dst_sess.close()

    # 4. 汇总
    print(f"[4/4] 完成，共迁移 {total} 行")
    if args.dry_run:
        print("      （dry-run 模式，未写入任何数据）")
    else:
        print("      下一步：重建分析宽表")
        print("      venv/bin/python create_testdata_table.py --csv <CSV路径> --table test_data --drop")


if __name__ == "__main__":
    main()
