"""结果审查新规则测试：与原始数据集的相似度比对 + 免审自动发布。

规则：
- 所有文件类型都可申请导出；
- 可提取文本文件与原始数据集 testData.csv 比对，相似度 ≥ 60% 转人工审核，
  低于 60% 免审核自动发布（立即出现在已发布列表可下载）；
- 图片/PDF/二进制等无法提取文本的文件免审自动发布；
- 原始基线缺失时安全默认转人工审核。
"""
import pytest

from app.config import settings
from app import review
from app.review import similarity_to_dataset, decide_export_review


# ---------------- 基线夹具 ----------------

BASELINE_HEADER = "id,score_alpha,score_beta,score_gamma"


def _baseline_rows(n=20):
    """每行使用独特长小数，保证"全新内容"的 token 不会碰巧命中基线。"""
    rows = []
    for i in range(n):
        rows.append(f"100{i},1.{i:04d}11,2.{i:04d}22,3.{i:04d}33")
    return rows


@pytest.fixture(autouse=True)
def _clear_baseline_cache():
    review._baseline_cache.clear()
    yield
    review._baseline_cache.clear()


@pytest.fixture
def baseline_file(tmp_path, monkeypatch):
    p = tmp_path / "baseline.csv"
    p.write_text(BASELINE_HEADER + "\n" + "\n".join(_baseline_rows()), encoding="utf-8")
    # decide_export_review 默认从 settings 取基线路径，测试中统一指向该夹具
    monkeypatch.setattr(settings, "dataset_csv_path", str(p))
    return str(p)


def _write(tmp_path, name, content, encoding="utf-8"):
    p = tmp_path / name
    if isinstance(content, str):
        p.write_text(content, encoding=encoding)
    else:
        p.write_bytes(content)
    return str(p)


# ---------------- 相似度函数单测 ----------------

def test_exact_slice_high_similarity_needs_review(tmp_path, baseline_file):
    rows = _baseline_rows()
    cand = _write(tmp_path, "slice.csv",
                  BASELINE_HEADER + "\n" + "\n".join(rows[:8]))
    score, _ = similarity_to_dataset(cand, baseline_file)
    assert score is not None and score >= 0.99
    decision, reason, s = decide_export_review(cand)
    assert decision == "review"
    assert s == score
    assert "60%" in reason


def test_distinct_analysis_low_similarity_auto(tmp_path, baseline_file):
    cand = _write(tmp_path, "analysis.csv",
                  "metric,value\n"
                  "zzz_rmsea_coef,9.87654321\n"
                  "yyy_cfi_index,8.76543210\n"
                  "xxx_tucker_lewis,7.65432109\n")
    score, _ = similarity_to_dataset(cand, baseline_file)
    assert score is not None and score < 0.6
    decision, reason, _ = decide_export_review(cand)
    assert decision == "auto"
    assert "免审核" in reason


def test_threshold_boundary_60_percent(tmp_path, baseline_file):
    rows = _baseline_rows()
    fresh = [
        "2001,9.11111111,8.22222222,7.33333333",
        "2002,9.44444444,8.55555555,7.66666666",
        "2003,9.77777777,8.88888888,7.99999999",
        "2004,6.12121212,5.34343434,4.56565656",
        "2005,3.98989898,2.87878787,1.76767676",
    ]
    sub = tmp_path / "split"
    sub.mkdir()
    # 10 行中 6 行逐行命中 -> 行命中率正好 0.60 -> 达阈值，转审核
    cand60 = _write(sub, "c60.csv",
                    BASELINE_HEADER + "\n" + "\n".join(rows[:6] + fresh[:4]))
    decision60, _, score60 = decide_export_review(cand60)
    assert round(score60, 2) == pytest.approx(0.60, abs=0.05)
    assert decision60 == "review"

    # 10 行中 5 行命中 -> 0.50，低于阈值 -> 免审
    cand50 = _write(sub, "c50.csv",
                    BASELINE_HEADER + "\n" + "\n".join(rows[:5] + fresh))
    decision50, _, score50 = decide_export_review(cand50)
    assert score50 < 0.6
    assert decision50 == "auto"


def test_binary_image_auto_even_without_comparison(tmp_path, baseline_file):
    # PNG 魔数 + 任意二进制：无法提取文本，不参与比对，免审
    cand = _write(tmp_path, "plot.png", b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 4)
    score, _ = similarity_to_dataset(cand, baseline_file)
    assert score is None
    decision, _, _ = decide_export_review(cand)
    assert decision == "auto"


def test_pdf_binary_auto(tmp_path, baseline_file):
    cand = _write(tmp_path, "report.pdf", b"%PDF-1.7\n" + b"\x00\x01binary" * 100)
    decision, _, score = decide_export_review(cand)
    assert decision == "auto" and score is None


def test_missing_baseline_forces_review(tmp_path, monkeypatch):
    cand = _write(tmp_path, "r.csv", "anything\n1,2,3\n")
    monkeypatch.setattr(settings, "dataset_csv_path", str(tmp_path / "nope.csv"))
    score, reason = similarity_to_dataset(cand)
    assert score is None and "基线" in reason
    decision, _, _ = decide_export_review(cand)
    assert decision == "review"


def test_empty_file_is_zero_similarity(tmp_path, baseline_file):
    cand = _write(tmp_path, "empty.csv", "")
    score, _ = similarity_to_dataset(cand, baseline_file)
    assert score == 0.0
    decision, _, _ = decide_export_review(cand)
    assert decision == "auto"


def test_gbk_baseline_and_candidate(tmp_path, monkeypatch):
    base = tmp_path / "gbk.csv"
    gbk_rows = ["编号,指标甲,指标乙"]
    gbk_rows += [f"{i},患者值甲{i}.{i:04d},乙值{i}.{i:05d}" for i in range(20)]
    base.write_bytes("\n".join(gbk_rows).encode("gbk"))
    cand_rows = gbk_rows[:1] + gbk_rows[1:9]
    cand = tmp_path / "c.csv"
    cand.write_bytes("\n".join(cand_rows).encode("gbk"))
    monkeypatch.setattr(settings, "dataset_csv_path", str(base))
    score, _ = similarity_to_dataset(str(cand), str(base))
    assert score is not None and score >= 0.9
    decision, _, _ = decide_export_review(str(cand))
    assert decision == "review"


def test_xlsx_extracted_and_low_similarity_auto(tmp_path, baseline_file):
    from openpyxl import Workbook
    wb = Workbook()
    ws = wb.active
    ws.append(["metric", "estimate"])
    ws.append(["zzz_special_coef", 9.87654321])
    ws.append(["yyy_special_se", 8.7654321])
    p = tmp_path / "book.xlsx"
    wb.save(p)
    text = review.extract_comparable_text(str(p))
    assert text is not None and "zzz_special_coef" in text
    score, _ = similarity_to_dataset(str(p), baseline_file)
    assert score is not None and score < 0.6
    assert decide_export_review(str(p))[0] == "auto"


# ---------------- API：/results/request-export 端到端 ----------------

def test_api_low_similarity_auto_published_and_download(
        client, auth_headers, pending_dir, baseline_file, monkeypatch):
    monkeypatch.setattr(settings, "dataset_csv_path", baseline_file)
    blob = ("metric,value\nzzz_rmsea,9.87654321\nyyy_cfi,8.76543210\n").encode("utf-8")
    with open(f"{pending_dir}/analysis_result.csv", "wb") as f:
        f.write(blob)

    resp = client.post("/results/request-export", headers=auth_headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["auto_approved"] == 1
    assert body["registered"] == 0
    assert body["auto_files"][0]["file_name"] == "analysis_result.csv"

    mine = client.get("/results/mine", headers=auth_headers).json()
    # /mine 的 pending 列表保留所有申请记录（含已自动通过），但不应有待审项
    assert all(p["status"] == "approved" for p in mine["pending"])
    assert [p["result_name"] for p in mine["published"]] == ["analysis_result.csv"]
    result_id = mine["published"][0]["id"]

    dl = client.post(f"/results/{result_id}/download", headers=auth_headers)
    assert dl.status_code == 200
    assert dl.content == blob


def test_api_high_similarity_stays_pending(
        client, auth_headers, pending_dir, baseline_file, monkeypatch):
    monkeypatch.setattr(settings, "dataset_csv_path", baseline_file)
    content = BASELINE_HEADER + "\n" + "\n".join(_baseline_rows()[:10])
    with open(f"{pending_dir}/raw_slice.csv", "w", encoding="utf-8") as f:
        f.write(content)

    body = client.post("/results/request-export", headers=auth_headers).json()
    assert body["registered"] == 1
    assert body["auto_approved"] == 0
    assert "60%" in body["files"][0]["reason"]

    mine = client.get("/results/mine", headers=auth_headers).json()
    assert [p["file_name"] for p in mine["pending"]] == ["raw_slice.csv"]
    assert mine["published"] == []

    # 高相似文件未发布，无下载入口（ExportResult 不存在 -> 404）
    dl = client.post("/results/999999/download", headers=auth_headers)
    assert dl.status_code == 404


def test_api_png_auto_without_baseline(client, auth_headers, pending_dir):
    # conftest 已把基线固定为不存在；图片不参与比对，仍应免审
    with open(f"{pending_dir}/diagram.png", "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + bytes(range(64)))
    body = client.post("/results/request-export", headers=auth_headers).json()
    assert body["auto_approved"] == 1
    assert body["registered"] == 0


def test_api_missing_baseline_text_forces_review(client, auth_headers, pending_dir):
    with open(f"{pending_dir}/notes.txt", "w", encoding="utf-8") as f:
        f.write("some analysis text that cannot be judged\n")
    body = client.post("/results/request-export", headers=auth_headers).json()
    assert body["registered"] == 1
    assert body["auto_approved"] == 0
    assert "基线" in body["files"][0]["reason"]


def test_api_mixed_batch_split_review_and_auto(
        client, auth_headers, pending_dir, baseline_file, monkeypatch):
    monkeypatch.setattr(settings, "dataset_csv_path", baseline_file)
    with open(f"{pending_dir}/raw.csv", "w", encoding="utf-8") as f:
        f.write(BASELINE_HEADER + "\n" + "\n".join(_baseline_rows()[:6]))
    with open(f"{pending_dir}/summary.csv", "w", encoding="utf-8") as f:
        f.write("metric,value\nzzz_unique,5.55555555\nyyy_unique,4.44444444\n")
    with open(f"{pending_dir}/img.png", "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\nbinary")

    body = client.post("/results/request-export", headers=auth_headers).json()
    assert body["registered"] == 1
    assert body["auto_approved"] == 2

    mine = client.get("/results/mine", headers=auth_headers).json()
    pending_waiting = [p["file_name"] for p in mine["pending"] if p["status"] == "pending"]
    assert pending_waiting == ["raw.csv"]
    assert sorted(p["result_name"] for p in mine["published"]) == ["img.png", "summary.csv"]
