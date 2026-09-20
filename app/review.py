"""结果审查服务

对 pending 目录中的结果文件做白名单审查：
- 字段白名单（只允许聚合结果列名）
- 行数上限
- 敏感字段正则（身份证/手机号/姓名等）
- 聚合检查（不允许导出明细行级数据）
"""
import re
import csv
import os
from typing import Tuple

# ---- 允许的文件类型 ----
ALLOWED_EXTENSIONS = {".csv", ".png", ".jpg", ".out", ".txt", ".log", ".pdf"}

# ---- CSV 字段白名单（只允许聚合/统计结果列名）----
FIELD_WHITELIST = {
    # 通用统计量
    "mean", "median", "std", "sd", "min", "max", "range",
    "n", "count", "freq", "frequency", "percent", "percentage",
    "sum", "total",
    # 回归系数
    "estimate", "coef", "coefficient", "beta", "b",
    "std_err", "se", "std_error", "standard_error",
    "t_value", "t", "z_value", "z",
    "p_value", "p", "pr", "pr_gt", "pr_lt",
    "ci_lower", "ci_upper", "ci_low", "ci_high",
    "df", "degrees_freedom",
    # 模型拟合
    "r_square", "r_squared", "rsquare", "r2",
    "adj_r_square", "adjusted_r_squared",
    "aic", "bic", "log_likelihood", "ll", "deviance",
    "rmsea", "cfi", "tli", "nnfi", "srmr", "chi_square", "chi_sq", "df_model",
    "n_obs", "n_groups", "observations",
    # 通用
    "variable", "term", "model", "group", "level", "category",
    "method", "type", "label", "name", "statistic", "value",
}

# ---- 敏感字段名（列名命中即拒绝）----
SENSITIVE_FIELD_NAMES = {
    "id", "uid", "user_id", "patient_id", "pid", "ssn", "social_security",
    "name", "fullname", "first_name", "last_name", "real_name",
    "phone", "mobile", "tel", "telephone", "phone_number",
    "id_card", "id_number", "identity", "identity_card",
    "address", "email", "mail", "ip", "ip_address",
    "birth", "birthday", "dob", "date_of_birth",
}

# ---- 敏感数据正则（在单元格内容中匹配）----
SENSITIVE_PATTERNS = [
    (re.compile(r"\d{15,18}"), "疑似身份证号"),
    (re.compile(r"1[3-9]\d{9}"), "疑似手机号"),
    (re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}"), "疑似邮箱地址"),
    (re.compile(r"[\u4e00-\u9fa5]{2,4}(?:先生|女士|同志)"), "疑似姓名"),
]

# ---- CSV 行数上限 ----
MAX_CSV_ROWS = 200

# ---- CSV 列数上限（防止导出宽表原始数据）----
MAX_CSV_COLS = 30

# ---- 允许的非明细文件关键词（.out/.log 文件中出现则通过）----
ALLOWED_OUT_KEYWORDS = ["model", "fit", "estimate", "coefficient", "summary", "result"]


def review_result(file_path: str, user=None) -> Tuple[bool, str]:
    """
    审查单个结果文件。

    参数:
        file_path: 文件完整路径
        user: 用户对象（含 user_id / username / dept_id）

    返回:
        (ok: bool, reason: str)
        ok=True 表示审查通过
        ok=False 时 reason 为拒绝原因
    """
    if not os.path.exists(file_path):
        return False, "文件不存在"

    file_name = os.path.basename(file_path)
    _, ext = os.path.splitext(file_name)
    ext = ext.lower()

    # 1. 文件类型白名单
    if ext not in ALLOWED_EXTENSIONS:
        return False, f"不支持的文件类型: {ext}"

    file_size = os.path.getsize(file_path)

    # 2. 文件大小上限 (50MB)
    if file_size > 50 * 1024 * 1024:
        return False, f"文件过大: {file_size} bytes（上限 50MB）"

    # 3. 图片直接通过（不可能包含行级数据）
    if ext in {".png", ".jpg", ".pdf"}:
        return True, "图片/PDF 类型，审查通过"

    # 4. CSV 文件 — 严格审查
    if ext == ".csv":
        return _review_csv(file_path)

    # 5. .out / .log / .txt — 检查是否含敏感信息
    if ext in {".out", ".log", ".txt"}:
        return _review_text(file_path)

    return True, "审查通过"


def _review_csv(file_path: str) -> Tuple[bool, str]:
    """审查 CSV 文件：字段白名单 + 行数上限 + 敏感数据检测"""
    try:
        with open(file_path, "r", encoding="utf-8-sig", errors="replace") as f:
            reader = csv.reader(f)
            try:
                header = next(reader)
            except StopIteration:
                return False, "CSV 文件为空"

            # 4a. 列数检查
            ncols = len(header)
            if ncols > MAX_CSV_COLS:
                return False, f"列数过多: {ncols}（上限 {MAX_CSV_COLS}），疑似导出原始宽表"

            # 4b. 字段名白名单检查
            header_lower = [h.strip().lower().replace(" ", "_") for h in header]
            non_whitelisted = []
            for h in header_lower:
                if h in SENSITIVE_FIELD_NAMES:
                    return False, f"包含敏感字段名: '{h}'，禁止导出"
                if h and h not in FIELD_WHITELIST and not h.startswith("est_") and not h.startswith("se_"):
                    non_whitelisted.append(h)

            if non_whitelisted:
                # 允许少量未在白名单但也不敏感的字段，但超过 50% 则拒绝
                ratio = len(non_whitelisted) / ncols if ncols > 0 else 1
                if ratio > 0.5:
                    return False, (
                        f"字段白名单检查失败，{len(non_whitelisted)}/{ncols} 列不在白名单中: "
                        f"{', '.join(non_whitelisted[:10])}"
                    )

            # 4c. 行数检查
            row_count = 0  # 数据行数（不含 header）
            for row in reader:
                row_count += 1
                if row_count > MAX_CSV_ROWS:
                    return False, f"行数超过上限 {MAX_CSV_ROWS}，疑似导出原始明细数据"

                # 4d. 敏感数据内容检测
                for cell in row:
                    for pattern, label in SENSITIVE_PATTERNS:
                        if pattern.search(str(cell)):
                            return False, f"数据中检测到{label}: {cell[:20]}..."

            return True, f"CSV 审查通过（{row_count} 行, {ncols} 列）"

    except Exception as e:
        return False, f"CSV 解析异常: {str(e)}"


def _review_text(file_path: str) -> Tuple[bool, str]:
    """审查文本类结果文件（.out / .log / .txt）"""
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(1024 * 1024)  # 最多读 1MB

        # 检查是否包含敏感信息
        for pattern, label in SENSITIVE_PATTERNS:
            if pattern.search(content):
                return False, f"文件中检测到{label}"

        # 检查是否有明细数据特征（大量连续数字行 = 原始数据）
        lines = content.splitlines()
        # 如果行数超 500 且每行看起来都是纯数字/小数 = 明细数据
        numeric_lines = sum(1 for line in lines if re.match(r"^[\d.\s]+$", line.strip()) and line.strip())
        if len(lines) > 500 and numeric_lines > len(lines) * 0.8:
            return False, f"疑似原始行级数据（{numeric_lines} 行纯数字行），禁止导出"

        return True, f"文本文件审查通过（{len(lines)} 行）"

    except Exception as e:
        return False, f"文件解析异常: {str(e)}"


def scan_pending_directory(pending_dir: str) -> list:
    """扫描 pending 目录，返回所有文件路径列表"""
    result = []
    if not os.path.exists(pending_dir):
        return result
    for entry in os.scandir(pending_dir):
        if entry.is_file():
            result.append(entry.path)
    return result
