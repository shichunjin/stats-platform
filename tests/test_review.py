"""review.py 单元测试 — 结果审查服务"""
import os
import csv
import tempfile

import pytest

from app.review import (
    review_result,
    scan_pending_directory,
    ALLOWED_EXTENSIONS,
    FIELD_WHITELIST,
    SENSITIVE_FIELD_NAMES,
    MAX_CSV_ROWS,
    MAX_CSV_COLS,
)


# ============================================================
# 辅助函数
# ============================================================

def _create_temp_file(content: str, suffix: str = ".csv") -> str:
    """创建临时文件并写入内容"""
    fd, path = tempfile.mkstemp(suffix=suffix)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(content)
    return path


def _create_csv(header: list, rows: list) -> str:
    """创建 CSV 文件"""
    fd, path = tempfile.mkstemp(suffix=".csv")
    with os.fdopen(fd, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        for row in rows:
            writer.writerow(row)
    return path


# ============================================================
# 测试：文件类型检查
# ============================================================

class TestFileTypeCheck:
    """文件类型白名单检查"""

    def test_allowed_extension_csv(self):
        """CSV 文件类型允许"""
        path = _create_csv(header=["mean", "std"], rows=[["1.0", "2.0"]])
        ok, _ = review_result(path)
        assert ok is True
        os.unlink(path)

    def test_allowed_extension_png(self):
        """PNG 图片允许"""
        path = _create_temp_file("fake-png", ".png")
        ok, reason = review_result(path)
        assert ok is True
        assert "图片" in reason
        os.unlink(path)

    def test_disallowed_extension_exe(self):
        """.exe 文件被拒绝"""
        path = _create_temp_file("malware", ".exe")
        ok, reason = review_result(path)
        assert ok is False
        assert "不支持的文件类型" in reason
        os.unlink(path)

    def test_disallowed_extension_zip(self):
        """.zip 文件被拒绝"""
        path = _create_temp_file("archive", ".zip")
        ok, reason = review_result(path)
        assert ok is False
        os.unlink(path)

    def test_file_not_exist(self):
        """不存在的文件返回失败"""
        ok, reason = review_result("/nonexistent/path/file.csv")
        assert ok is False
        assert "文件不存在" in reason


# ============================================================
# 测试：CSV 审查 — 正常通过
# ============================================================

class TestCsvApproved:
    """CSV 审查通过的场景"""

    def test_simple_stats_csv(self):
        """简单统计结果 CSV 通过"""
        path = _create_csv(
            header=["variable", "mean", "std", "n"],
            rows=[["age", "35.2", "10.1", "100"]],
        )
        ok, reason = review_result(path)
        assert ok is True
        assert "CSV 审查通过" in reason
        os.unlink(path)

    def test_regression_results_csv(self):
        """回归系数结果 CSV 通过"""
        path = _create_csv(
            header=["term", "estimate", "std_err", "t_value", "p_value"],
            rows=[
                ["intercept", "1.5", "0.3", "5.0", "0.001"],
                ["x1", "0.8", "0.1", "8.0", "0.0001"],
            ],
        )
        ok, reason = review_result(path)
        assert ok is True
        os.unlink(path)

    def test_model_fit_csv(self):
        """模型拟合指标 CSV 通过"""
        path = _create_csv(
            header=["model", "aic", "bic", "rmsea", "cfi"],
            rows=[["model1", "100.5", "110.2", "0.05", "0.95"]],
        )
        ok, _ = review_result(path)
        assert ok is True
        os.unlink(path)


# ============================================================
# 测试：CSV 审查 — 敏感字段名
# ============================================================

class TestCsvSensitiveFields:
    """CSV 包含敏感字段名时被拒绝"""

    @pytest.mark.parametrize("field", [
        "id", "name", "phone", "id_card", "email", "address",
        "user_id", "mobile", "ssn", "birthday",
    ])
    def test_sensitive_field_name(self, field):
        """包含敏感字段名直接拒绝"""
        path = _create_csv(header=[field, "mean"], rows=[["x", "1.0"]])
        ok, reason = review_result(path)
        assert ok is False
        assert "敏感字段名" in reason
        os.unlink(path)


# ============================================================
# 测试：CSV 审查 — 敏感数据内容
# ============================================================

class TestCsvSensitiveData:
    """CSV 单元格中包含敏感数据时被拒绝"""

    def test_phone_number_in_data(self):
        """数据中包含手机号"""
        path = _create_csv(
            header=["mean", "note"],
            rows=[["1.0", "联系电话13812345678"]],
        )
        ok, reason = review_result(path)
        assert ok is False
        assert "疑似手机号" in reason
        os.unlink(path)

    def test_id_card_in_data(self):
        """数据中包含身份证号"""
        path = _create_csv(
            header=["mean", "note"],
            rows=[["1.0", "身份证110101199001011234"]],
        )
        ok, reason = review_result(path)
        assert ok is False
        assert "疑似身份证号" in reason
        os.unlink(path)

    def test_email_in_data(self):
        """数据中包含邮箱"""
        path = _create_csv(
            header=["mean", "note"],
            rows=[["1.0", "contact@example.com"]],
        )
        ok, reason = review_result(path)
        assert ok is False
        assert "疑似邮箱" in reason
        os.unlink(path)


# ============================================================
# 测试：CSV 审查 — 行数与列数上限
# ============================================================

class TestCsvLimits:
    """CSV 行数/列数上限检查"""

    def test_too_many_rows(self):
        """行数超过上限"""
        rows = [["1.0", "2.0"] for _ in range(MAX_CSV_ROWS + 1)]
        path = _create_csv(header=["mean", "std"], rows=rows)
        ok, reason = review_result(path)
        assert ok is False
        assert "行数超过上限" in reason
        os.unlink(path)

    def test_exactly_max_rows(self):
        """刚好等于上限行数"""
        rows = [["1.0", "2.0"] for _ in range(MAX_CSV_ROWS)]
        path = _create_csv(header=["mean", "std"], rows=rows)
        ok, _ = review_result(path)
        assert ok is True
        os.unlink(path)

    def test_too_many_cols(self):
        """列数超过上限"""
        header = [f"col_{i}" for i in range(MAX_CSV_COLS + 1)]
        path = _create_csv(header=header, rows=[["1.0"] * (MAX_CSV_COLS + 1)])
        ok, reason = review_result(path)
        assert ok is False
        assert "列数过多" in reason
        os.unlink(path)


# ============================================================
# 测试：CSV 审查 — 字段白名单
# ============================================================

class TestCsvFieldWhitelist:
    """CSV 字段白名单检查"""

    def test_mostly_non_whitelisted_fields(self):
        """超过 50% 的字段不在白名单"""
        header = ["col_a", "col_b", "col_c"]  # 都不在白名单
        path = _create_csv(header=header, rows=[["1.0", "2.0", "3.0"]])
        ok, reason = review_result(path)
        assert ok is False
        assert "字段白名单" in reason
        os.unlink(path)

    def test_mixed_fields_half_allowed(self):
        """一半字段在白名单，一半不在（>50% 非白名单时拒绝）"""
        header = ["mean", "col_x", "col_y"]  # 1/3 在白名单，2/3 不在
        path = _create_csv(header=header, rows=[["1.0", "2.0", "3.0"]])
        ok, reason = review_result(path)
        assert ok is False
        os.unlink(path)


# ============================================================
# 测试：图片/PDF 直接通过
# ============================================================

class TestImageDirectPass:
    """图片和 PDF 文件直接通过"""

    def test_png_passes(self):
        path = _create_temp_file("fake png data", ".png")
        ok, reason = review_result(path)
        assert ok is True
        assert "图片" in reason
        os.unlink(path)

    def test_jpg_passes(self):
        path = _create_temp_file("fake jpg data", ".jpg")
        ok, _ = review_result(path)
        assert ok is True
        os.unlink(path)

    def test_pdf_passes(self):
        path = _create_temp_file("fake pdf data", ".pdf")
        ok, _ = review_result(path)
        assert ok is True
        os.unlink(path)


# ============================================================
# 测试：文本文件审查 (.out / .log / .txt)
# ============================================================

class TestTextFileReview:
    """文本类结果文件审查"""

    def test_clean_model_output(self):
        """正常的模型输出文件通过"""
        content = """
        Model Fit Statistics
        AIC = 100.5
        BIC = 110.2
        RMSEA = 0.05
        CFI = 0.95
        """
        path = _create_temp_file(content, ".out")
        ok, _ = review_result(path)
        assert ok is True
        os.unlink(path)

    def test_text_with_phone(self):
        """文本文件含手机号"""
        content = "联系: 13812345678"
        path = _create_temp_file(content, ".log")
        ok, reason = review_result(path)
        assert ok is False
        assert "疑似手机号" in reason
        os.unlink(path)

    def test_text_with_email(self):
        """文本文件含邮箱"""
        content = "Email: test@example.com"
        path = _create_temp_file(content, ".txt")
        ok, reason = review_result(path)
        assert ok is False
        assert "疑似邮箱" in reason
        os.unlink(path)

    def test_bulk_numeric_data_rejected(self):
        """大量连续数字行 = 原始数据"""
        lines = ["1.0 2.0 3.0"] * 600
        content = "\n".join(lines)
        path = _create_temp_file(content, ".out")
        ok, reason = review_result(path)
        assert ok is False
        assert "原始行级数据" in reason
        os.unlink(path)

    def test_empty_csv_rejected(self):
        """空 CSV 文件被拒绝"""
        path = _create_temp_file("", ".csv")
        ok, reason = review_result(path)
        assert ok is False
        assert "为空" in reason
        os.unlink(path)


# ============================================================
# 测试：scan_pending_directory
# ============================================================

class TestScanPendingDirectory:
    """pending 目录扫描函数"""

    def test_scan_empty_dir(self, tmp_path):
        """空目录返回空列表"""
        result = scan_pending_directory(str(tmp_path))
        assert result == []

    def test_scan_with_files(self, tmp_path):
        """目录有文件时返回文件列表"""
        f1 = tmp_path / "result1.csv"
        f2 = tmp_path / "plot.png"
        f1.write_text("mean,std\n1,2")
        f2.write_text("fake png")

        result = scan_pending_directory(str(tmp_path))
        assert len(result) == 2
        assert str(f1) in result
        assert str(f2) in result

    def test_scan_ignores_subdirs(self, tmp_path):
        """目录扫描忽略子目录"""
        (tmp_path / "subdir").mkdir()
        f1 = tmp_path / "result.csv"
        f1.write_text("mean\n1")

        result = scan_pending_directory(str(tmp_path))
        assert len(result) == 1

    def test_scan_nonexistent_dir(self):
        """不存在的目录返回空列表"""
        result = scan_pending_directory("/nonexistent/dir")
        assert result == []
