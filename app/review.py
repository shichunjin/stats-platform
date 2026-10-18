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


def file_sha256(file_path: str) -> str:
    """计算文件内容的 SHA256（分块读取，支持大文件）。

    安全修复 B9：导出申请时记录内容哈希，管理员审核通过前复核，
    防止「申请后改写同名待导出文件」使未审查内容被发布。
    """
    import hashlib
    h = hashlib.sha256()
    with open(file_path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ============================================================
# 与原始数据集的相似度比对（免审 / 转人工审核的依据）
# ============================================================
#
# 规则（安全修复 A2 后）：
#   - 导出文件按扩展名门禁分三类：
#     1) 文本类（csv/txt/out/log/tsv/dat/tab/json/xml）：与原始数据集 testData
#        比对相似度，≥ EXPORT_REVIEW_SIMILARITY_THRESHOLD（默认 60%）转人工；
#     2) 图片类（png/jpg/jpeg）：不可能包含行级明细，免审自动通过；
#     3) 统计软件原生格式/压缩包/文档（dta/rds/xlsx/zip/pdf 等）：可能内嵌
#        原始数据且无法可靠比对，一律转人工审核；
#   - 不在以上三类中的未知类型：直接拒绝（reject）；
#   - 二进制内容伪装成文本扩展名（如 .dta 改名 .txt）：控制字符占比检测识别，
#     无法可靠比对，安全默认转人工；
#   - 文本经 Base64 等编码后写入：自动解码一层并入比对；解码后仍为二进制
#     （加密/压缩再编码）或超长不可解码 token 视为混淆，转人工；
#   - 原始数据基线文件缺失时无法判定，安全默认转人工审核。

import base64
from collections import Counter

from app.config import settings as _settings

# 可直接按文本读取的扩展名
_TEXT_EXTS = {".csv", ".txt", ".out", ".log", ".tsv", ".dat", ".tab", ".json", ".xml"}
# 参与比对时读取的最大规模（防止异常大文件拖垮服务）
_MAX_BASELINE_LINES = 20000
_MAX_CANDIDATE_CHARS = 2 * 1024 * 1024
_MAX_XLSX_ROWS = 20000

# 基线缓存：{abspath: (mtime_ns, size, line_set, token_counter, header)}
_baseline_cache: dict = {}

_ws_re = re.compile(r"\s+")
_token_re = re.compile(r"[0-9A-Za-z_.]+")
_B64_BLOCK_RE = re.compile(r"[A-Za-z0-9+/=]{200,}")


def _looks_binary(raw: bytes) -> bool:
    """采样检测二进制内容：控制字符（排除常见文本空白符）占比 > 2% 视为二进制。"""
    sample = raw[:65536]
    if not sample:
        return False
    ctrl = sum(1 for b in sample if b < 0x20 and b not in (0x09, 0x0A, 0x0D, 0x0C))
    return ctrl / len(sample) > 0.02


def _augment_base64_text(text: str) -> tuple[str, bool]:
    """编码混淆防护（安全修复 A2）。

    检测文本中的长 Base64 块：
    - 能解码为可读文本（如 Base64 后的原始数据表）→ 解码内容并入比对文本；
    - 解码后仍为二进制（对原始数据加密/压缩再编码）→ 视为混淆，返回 True；
    - 超长且无法解码的连续 token（哈希串/密文）→ 视为混淆，返回 True。
    返回 (增强后的文本, 是否混淆)。
    """
    blocks = _B64_BLOCK_RE.findall(text)
    if not blocks:
        return text, False
    decoded_parts: list[str] = []
    for block in blocks:
        padded = block + "=" * (-len(block) % 4)
        try:
            raw = base64.b64decode(padded, validate=True)
        except Exception:
            try:
                raw = base64.urlsafe_b64decode(padded)
            except Exception:
                return text, True
        if _looks_binary(raw):
            return text, True
        decoded_parts.append(_decode_bytes(raw))
    if decoded_parts:
        text = text + "\n" + "\n".join(decoded_parts)
    return text, False


def _normalize_line(line: str) -> str:
    return _ws_re.sub(" ", line.strip())


def _decode_bytes(raw: bytes) -> str:
    """兼容 UTF-8/GBK 的整体解码（testData.csv 生产为 GBK）。"""
    for enc in ("utf-8-sig", "gbk", "latin-1"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", errors="replace")


def _read_text_file(path: str, max_bytes: int | None = None) -> str:
    with open(path, "rb") as f:
        raw = f.read() if max_bytes is None else f.read(max_bytes)
    return _decode_bytes(raw)


def _load_baseline(baseline_path: str):
    """加载原始数据集基线：行集合 + token 多重集 + 表头行。按 mtime 缓存。"""
    try:
        st = os.stat(baseline_path)
    except OSError:
        return None

    key = os.path.abspath(baseline_path)
    cached = _baseline_cache.get(key)
    if cached and cached[0] == st.st_mtime_ns and cached[1] == st.st_size:
        return cached[2:]

    line_set: set[str] = set()
    tokens: Counter = Counter()
    header = ""
    n = 0
    for raw in _read_text_file(baseline_path).splitlines():
        norm = _normalize_line(raw)
        if not norm:
            continue
        if n == 0:
            header = norm
        line_set.add(norm)
        tokens.update(_token_re.findall(norm.lower()))
        n += 1
        if n >= _MAX_BASELINE_LINES:
            break

    result = (line_set, tokens, header)
    _baseline_cache[key] = (st.st_mtime_ns, st.st_size) + result
    return result


def _extract_xlsx_text(path: str) -> str:
    """把 xlsx 各工作表的单元格按行拼成 CSV 样式文本。"""
    try:
        from openpyxl import load_workbook
    except ImportError:
        return ""
    try:
        wb = load_workbook(path, read_only=True, data_only=True)
    except Exception:
        return ""
    parts: list[str] = []
    try:
        for ws in wb.worksheets:
            row_n = 0
            for row in ws.iter_rows(values_only=True):
                parts.append(",".join("" if c is None else str(c) for c in row))
                row_n += 1
                if row_n >= _MAX_XLSX_ROWS:
                    break
    finally:
        wb.close()
    return "\n".join(parts)


def extract_comparable_text(file_path: str) -> str | None:
    """提取待导出文件中可用于比对的文本。

    返回 None 表示该类型无法提取文本（图片/PDF/二进制），不参与相似度比对。
    """
    ext = os.path.splitext(file_path)[1].lower()
    if ext in _TEXT_EXTS:
        try:
            with open(file_path, "rb") as f:
                raw = f.read(_MAX_CANDIDATE_CHARS)
        except OSError:
            return ""
        # 安全修复 A2：二进制内容伪装成文本扩展名（如 .dta/.zip/.rds 改名 .txt）
        # 无法可靠比对，返回 None → 调用方安全默认转人工审核
        if _looks_binary(raw):
            return None
        for enc in ("utf-8-sig", "gbk", "latin-1"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("latin-1", errors="replace")
    if ext == ".xlsx":
        return _extract_xlsx_text(file_path)
    return None


def similarity_to_dataset(file_path: str, baseline_path: str | None = None
                          ) -> tuple[float | None, str]:
    """计算待导出文件与原始数据集的相似度（0~1）。

    取两个指标的较大值：
      1. 行命中率：候选文件中有多少行在原始数据集里逐行出现（复制/切片原始数据时高）；
      2. token 覆盖率：候选内容的 token 有多少比例能在原始数据集中找到
         （换分隔符/去掉引号等格式变化时仍然敏感）。
    表头行（与基线表头完全相同）不计入命中，避免小文件被一个表头推高相似度。
    候选内容中的 Base64 块会先解码再并入比对（防编码混淆绕过，安全修复 A2）。

    返回 (score, reason)。score=None 表示无法判定（调用方应安全默认转人工审核）：
      - 文件为二进制/图片类，或二进制伪装成文本；
      - 内容疑似编码/混淆（Base64 解码后仍为二进制、超长不可解码 token）；
      - 原始数据基线文件缺失。
    """
    text = extract_comparable_text(file_path)
    if text is None:
        return None, "无法提取可比文本（二进制/图片类），转人工审核"

    # 安全修复 A2：编码混淆防护 —— Base64 等编码后的原始数据写入文本文件
    text, obfuscated = _augment_base64_text(text)
    if obfuscated:
        return None, "内容疑似经编码/混淆处理且无法还原为可读文本，转人工审核"

    base = _load_baseline(baseline_path or _settings.dataset_csv_path)
    if base is None:
        return None, "原始数据基线文件不可用，转人工审核"

    line_set, base_tokens, header = base
    cand_lines = [ln for ln in (_normalize_line(x) for x in text.splitlines()) if ln]
    if not cand_lines:
        return 0.0, "文件内容为空"

    data_lines = [ln for ln in cand_lines if ln != header]
    if data_lines:
        hits = sum(1 for ln in data_lines if ln in line_set)
        line_ratio = hits / len(data_lines)
    else:
        line_ratio = 0.0

    cand_counter: Counter = Counter()
    for ln in data_lines:
        cand_counter.update(_token_re.findall(ln.lower()))
    total = sum(cand_counter.values())
    if total:
        overlap = sum((cand_counter & base_tokens).values())
        token_ratio = overlap / total
    else:
        token_ratio = 0.0

    score = round(max(line_ratio, token_ratio), 4)
    return score, (f"行命中率 {line_ratio * 100:.0f}%，token 覆盖率 {token_ratio * 100:.0f}%，"
                   f"相似度 {score * 100:.0f}%")


# ---- 导出文件类型门禁（安全修复 A2）----
# 文本类：可参与相似度自动判定，低于阈值可免审
_AUTO_TEXT_EXTS = {".csv", ".txt", ".out", ".log", ".tsv", ".dat", ".tab", ".json", ".xml"}
# 图片类：不可能包含行级明细数据，免审自动通过
_IMAGE_EXTS = {".png", ".jpg", ".jpeg"}
# 统计软件原生格式 / 压缩包 / 文档：可能内嵌原始数据且无法可靠比对，一律转人工
_ALWAYS_REVIEW_EXTS = {
    ".xlsx", ".xls", ".xlsm", ".dta", ".rds", ".rdata", ".rda", ".sav", ".por",
    ".zip", ".7z", ".rar", ".gz", ".tgz", ".tar", ".pdf",
    ".doc", ".docx", ".ppt", ".pptx", ".h5", ".hdf5", ".mat", ".npz",
    ".parquet", ".feather", ".sqlite", ".db",
}


def decide_export_review(file_path: str, threshold: float | None = None
                         ) -> tuple[str, str, float | None]:
    """返回 (decision, reason, score)；decision ∈ {review, auto, reject}。

    - reject：不在允许导出的类型白名单内，直接拒绝；
    - review：统计软件原生格式/压缩包/文档一律转人工；文本类相似度达到阈值、
      内容疑似编码混淆、或原始基线缺失无法判定（安全默认）；
    - auto：图片文件；或文本类相似度低于阈值且内容可读、类型可判定。

    注意：auto 仅表示"免相似度审核"，调用方仍须通过 review_result 规则审查
    （扩展名/字段白名单/敏感信息/行数）后才可发布（安全修复 B8）。
    """
    thr = _settings.export_review_similarity_threshold if threshold is None else threshold
    ext = os.path.splitext(file_path)[1].lower()

    # 1. 类型门禁：未知/未允许类型直接拒绝
    if ext not in _AUTO_TEXT_EXTS and ext not in _IMAGE_EXTS \
            and ext not in _ALWAYS_REVIEW_EXTS:
        return "reject", f"不允许导出的文件类型: {ext}", None

    # 2. 统计软件原生格式/压缩包/文档：无法可靠自动判定，一律转人工
    if ext in _ALWAYS_REVIEW_EXTS:
        return ("review",
                "该文件类型（统计软件原生格式/压缩包/文档）可能内嵌原始数据，转管理员人工审核",
                None)

    # 3. 图片：不可能包含行级明细，免审自动通过
    if ext in _IMAGE_EXTS:
        return "auto", "图片文件，不包含行级明细数据，免审自动通过", None

    # 4. 文本类：相似度比对 + 编码混淆防护
    score, detail = similarity_to_dataset(file_path)
    if score is None:
        # 基线缺失、二进制伪装文本、编码混淆等无法判定情形：安全默认转人工
        return "review", detail, None
    if score >= thr:
        return "review", f"{detail}，达到/超过阈值 {thr * 100:.0f}%，需管理员审核", score
    return "auto", f"{detail}，低于阈值 {thr * 100:.0f}%，免审核自动通过", score
