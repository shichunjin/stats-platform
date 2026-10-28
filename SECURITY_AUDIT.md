# 统计软件托管平台 — 系统安全与架构审计报告

- 审计日期：2026-10-22
- 审计范围：`app/`（FastAPI 后端）、`frontend/src`（Vue3 前端）、`schema.sql`、`nginx/`、`powershell/`、`guacamole/`、`tests/`
- 审计方式：静态代码审查 + 配置核对 + 本地启动/测试复现
- 代码基线：README 中标注的 "安全修复 A1~A4 / B1~B15 / C1~C7" 已落地后的当前主干

---

## 一、系统概览

### 1.1 模块划分

| 模块 | 位置 | 职责 |
|---|---|---|
| 认证授权 | `app/auth.py`、`app/routers/auth.py` | 注册/登录/JWT/改密/密码策略 |
| 权限守卫 | `app/auth.py::require_admin / require_superadmin` | 三档角色：user / admin / superadmin |
| 远程会话 | `app/routers/session.py`、`app/guac.py` | 一人一专属 RDP 连接，返回 Guacamole URL |
| 数据申请 | `app/routers/applies.py` | 用户提交申请、管理员入队/驳回 |
| 数据生成 | `app/routers/data.py`、`app/dataset.py`、`app/jobs.py` | 按筛选从宽表生成 Excel，后台线程 + SFTP 推送到 W: 盘 |
| 结果导出审查 | `app/routers/results.py`、`app/review.py` | SFTP 回拉 pending 文件 → 相似度判定 → 免审发布 / 人工审核 |
| 管理员 | `app/routers/admin.py` | 审计日志、导出审核、用户/角色管理、平台连接配置 |
| 消息中心 | `app/routers/messages.py` | 站内通知 |
| 外部系统同步 | `app/windows_account.py`、`app/guac.py`、`app/transfer.py` | Windows 本地账号、Guacamole JDBC 用户/连接、SFTP 传输 |
| 启动迁移 | `app/main.py::_migrate_schema` | 启动时 `create_all` + 手写幂等 DDL |

### 1.2 关键数据流

**链路 A：身份链路**

```
注册 → sync_windows_user(SSH→PowerShell 建本地账号)
     → upsert_guac_user(写 Guacamole JDBC 库)
     → 平台 User 落库
登录 → pbkdf2 校验 / 演示账号字典校验 → 签发 JWT(8h, 含 role + pwd_ver)
```

**链路 B：数据下发链路**

```
用户 POST /user/data-applies
  → 管理员 /admin/data-applies/{id}/process
  → 管理员 POST /data/generate (filters + target_user_id + apply_id)
  → 认领置 generating，提交 ThreadPoolExecutor(2 worker)
  → generate_filtered_excel_from_table (SELECT 全列 + WHERE)
  → upload_file_to_windows (SFTP + icacls 锁定为本人私有)  → W:\{用户名}\
  → 申请置 completed + 站内消息
```

**链路 C：结果导出链路（最高风险）**

```
用户在 RDP 内把结果放入 C:\pending\{用户名}\
  → POST /results/request-export
      ① SFTP list_remote_files  （新建 1 条 SSH 连接）
      ② 每个文件 download_file_from_windows（每文件再新建 1 条 SSH 连接）
      ③ 对每个文件 file_sha256（全量读盘）
      ④ decide_export_review：扩展名门禁 → 相似度比对（读前 2MB）
      ⑤ 判定 auto → review_result 规则审查 → 免审自动发布
         判定 review → 等管理员 /admin/pending/{id}/approve
  → 复制到 fileserver/published/{pending_file_id}/ + 写 export_results(30 天)
  → POST /results/{id}/download（校验 user_id + expires_at）
```

### 1.3 权限边界

| 边界 | 实现 | 评价 |
|---|---|---|
| 接口级角色 | `require_admin` / `require_superadmin` 依赖 | 覆盖完整，未发现遗漏的管理员路由 |
| 数据归属 | 所有查询均带 `user_id == current_user.id` | 越权（IDOR）检查到位 |
| 数据范围(scopes) | `scopes` / `user_scope` 表已从 ORM 移除 | 已下线，改为「管理员按申请定向下发」 |
| Windows 物理隔离 | NTFS ACL(仅本人/SYSTEM/Admins) + SMB ABE + 隐藏 C: | 依赖登录脚本与 `enforce-output-location.ps1` |
| RDP 通道 | `disable-copy/paste/drive/print` 强制写入连接参数 | 有效 |
| 超级管理员产生 | 仅 `python -m app.cli promote`，API 白名单排除 | 设计合理 |

### 1.4 高风险区域（按风险排序）

1. **导出「免审自动发布」判定** — `app/review.py::decide_export_review`，是原始数据外泄的唯一自动闸门
2. **`.env` 与 `config.py` 漂移** — 已导致应用与测试完全无法启动
3. **管理员直接下发数据分支** — 存在必然触发的 500，且无二次确认
4. **SFTP/SSH 外连** — 无连接池、无限流、主机密钥不校验
5. **启动期自动 DDL 迁移** — 多 worker 竞争、无 Alembic

---

## 二、问题清单

| 编号 | 模块 | 问题描述 | 风险等级 | 影响范围 | 修复优先级 |
|---|---|---|---|---|---|
| SEC-01 | 配置/启动 | `.env` 残留废弃变量 `RSTUDIO_PATH/MPLUS_PATH/STATA_PATH`，pydantic-settings `extra=forbid` 导致 `Settings()` 抛错，应用与全部测试无法启动 | P0 | 全系统 | 立即 |
| SEC-02 | results/review | 免审自动发布可被「大文件只比对前 2MB + 分片 + 填充」规避，使原始明细绕过人工审核直接可下载 | P0 | 原始数据外泄 | 立即 |
| SEC-03 | data/dataset | 相似度基线 `testData.csv` 与实际下发数据源 `test_data` 宽表不是同一份，判定基线漂移 | P1 | 免审判定失真 | 立即 |
| LOG-01 | data | `/data/generate` 无 `apply_id` 分支传入 ORM 不存在的 `target_user_id`，必抛 `TypeError` → 500 | P0 | 管理员直接下发功能不可用 | 立即 |
| LOG-02 | admin | `reject_pending` 无行锁、无条件更新，与 `approve_pending` 并发可产生「文件已发布但申请显示 rejected」 | P1 | 状态不一致/绕过驳回 | 立即 |
| LOG-03 | applies/data | 对 `generating` 状态的申请可驳回，后台线程完成后把状态改回 `completed`，用户已拿到数据却显示驳回 | P1 | 审批状态可被回退 | 立即 |
| SEC-04 | rate_limit | `get_client_ip` 无条件信任 `X-Forwarded-For`，可伪造 → 登录/注册限流完全绕过、审计日志 IP 投毒 | P1 | 认证爆破 / 审计失效 | 高 |
| SEC-05 | results | `/results/request-export` 无限流、无文件数量/大小上限，每次调用建立 N+1 条 SSH 连接并对全目录做全量 SHA256 | P1 | DoS / Windows 主机 SSH 耗尽 | 高 |
| SEC-06 | admin | `platform_config.workspace_dir` 无路径白名单，admin 可把投递目录改成 Windows 任意路径（如 `C:/Windows/System32`） | P1 | 任意文件写入/覆盖 | 高 |
| SEC-07 | main | SPA 回退中间件注册在安全头中间件之后（Starlette `insert(0)`），`index.html` 实际不带 CSP / nosniff / Referrer-Policy | P2 | XSS 纵深防御失效 | 高 |
| SEC-08 | transfer | `paramiko.AutoAddPolicy()` 不校验主机密钥，SSH/SFTP 可被 MITM | P2 | 凭据与数据被截获 | 高 |
| SEC-09 | auth | 无账号停用/删除/封禁接口，`is_active` 无管理入口，离职账号无法关停 | P2 | 僵尸账号长期有效 | 高 |
| SEC-10 | auth | JWT 无 `jti`、无登出黑名单、无刷新机制；前端 `logout()` 仅清 localStorage，token 仍有效至 8h 到期 | P2 | 令牌泄露后无法吊销 | 中 |
| SEC-11 | auth/README | 演示账号弱密码（admin123 / user123）；README 与 `.env` 明文写入生产主机 IP `8.133.223.251` 与域名 | P2 | 凭据与资产暴露 | 中 |
| SEC-12 | admin | `/admin/platform/test` 无限流，`port` 任意 → 可被用作内网端口扫描器 | P2 | SSRF 辅助探测 | 中 |
| SEC-13 | auth | 注册先建 Windows/Guacamole 账号再建平台账号，平台 `db.commit()` 失败会留下孤儿外部账号 | P2 | 三端状态分叉 | 中 |
| PERF-01 | results | `request-export` 每次对 pending 目录所有文件全量 SHA256，且每文件新建一条 SSH 连接 | P1 | 大目录下请求超时 | 高 |
| PERF-02 | applies | `_to_dict` 访问 `a.user.username` 触发懒加载，列表 500 条 = 500 次额外查询（N+1） | P2 | 管理员队列页慢 | 中 |
| PERF-03 | results | `/results/mine` 无分页，pending + published 全量返回 | P2 | 历史积累后响应膨胀 | 中 |
| PERF-04 | dataset | `analyze_table_columns` 采样 5000 行 × 612 列全 Python 遍历（约 300 万次判定） | P2 | 首次列分析卡顿 | 中 |
| PERF-05 | jobs | 后台任务 `inflight` 为进程内集合，多 worker 部署失效；进程重启后 `generating` 无定时补偿 | P2 | 任务丢失/状态悬挂 | 中 |
| PERF-06 | 全局 | 无统一超时/重试/熔断；SFTP 15s、icacls 20s、PowerShell 25s 各自为政，失败无重试 | P2 | 外部依赖抖动即失败 | 中 |
| CODE-01 | tests | 测试套件当前**完全无法运行**（SEC-01）；且 `/data/generate` 无 apply_id 分支零覆盖，该 bug 才能溜到主干 | P0 | 质量门禁失效 | 立即 |
| CODE-02 | admin | 人工审核通过有效期硬编码 `timedelta(days=30)`，与 `settings.export_publish_valid_days` 不一致（双源真相） | P2 | 配置改了不生效 | 中 |
| CODE-03 | 全局 | `except Exception` 宽泛捕获后仅 `logger.warning`，多处吞掉异常（如演示账号同步、工作区补建） | P2 | 故障静默 | 中 |
| CODE-04 | schemas | `DataApplyOut.target_user_id` 必填，但 ORM 无该字段，前后端类型契约与实现漂移 | P2 | 接口契约不可信 | 中 |
| CODE-05 | results/admin | `_published_dir()` 在 `results.py` 与 `admin.py` 重复定义 | P3 | 维护冗余 | 低 |
| CODE-06 | 全局 | `audit_logs.detail` 直接拼接用户可控内容（`purpose`、`reason`、文件名），无长度截断与清洗 | P3 | 日志膨胀/注入 | 低 |
| CODE-07 | 全局 | 无统一错误码规范，`detail` 为中文自由文本，前端只能按 HTTP 状态码分支 | P3 | 联调与监控困难 | 低 |
| ARCH-01 | main | 启动时 `create_all` + 手写 DDL 迁移，无 Alembic；多 worker 并发启动存在迁移竞争 | P2 | schema 演进风险 | 中 |
| ARCH-02 | main | 启动即同步演示账号到 Windows/Guacamole（每次重启以 .env 为准收敛），多 worker 重复执行且失败静默 | P2 | 启动副作用 | 中 |
| ARCH-03 | 全局 | 无监控指标、无告警、无结构化日志；`/health` 仅返回 `{"status":"ok"}` 不做依赖探活 | P2 | 故障不可见 | 中 |
| ARCH-04 | database | `.env` 默认 SQLite；SQLite 下 `with_for_update()` 为空操作，`approve` 并发保护降级为条件更新兜底 | P2 | 并发安全隐患 | 中 |
| ARCH-05 | schema.sql | `scopes` / `user_scope` / `users.dept_id` 仍存在于 DDL 与 README，ORM 已移除 | P3 | 文档与实现漂移 | 低 |

> 风险等级：P0 阻断 / P1 高 / P2 中 / P3 低

---

## 三、详细审计报告

> 以下按优先级展开，每项给出问题位置、类型、风险、复现、影响、修复方案、代码、回归验证。

---

### SEC-01 · 配置漂移导致应用与测试完全无法启动 【P0 · 安全/配置】

**1. 问题位置**
- `app/config.py:117`（`model_config`，未设置 `extra`）
- 本地 `.env:25-27`（`RSTUDIO_PATH` / `MPLUS_PATH` / `STATA_PATH`）

**2. 问题类型**：安全（可用性 + 配置治理）

**3. 风险等级**：P0

**4. 触发条件（已实测复现）**

```
$ ./.venv/Scripts/python.exe -m pytest -q
ImportError while loading conftest ...
pydantic_core.ValidationError: 3 validation errors for Settings
  rstudio_path  Extra inputs are not permitted
  mplus_path    Extra inputs are not permitted
  stata_path    Extra inputs are not permitted
```

直接 `uvicorn app.main:app` 同样启动失败。根因是「软件维度下线」时从 `Settings` 删了字段，但没有同步清理 `.env`；pydantic-settings 默认 `extra="forbid"`。

**5. 影响说明**
- 任何部署/升级到该基线的环境都会启动失败；
- CI 无法跑测试 → 质量门禁整体失效（见 CODE-01），后续所有 bug 都会无阻拦地进入主干；
- 运维为"先跑起来"往往会随手改 `Settings` 加回字段或改 `extra="ignore"`，后者会让真实的配置拼写错误被静默忽略。

**6. 修复建议**
- 立即删除 `.env` 中三个废弃键，并同步清理 `.env.example`；
- 在 `Settings` 中显式声明 `model_config` 的 `extra="forbid"` 保持 fail-fast（保留），同时把 `.env.example` 纳入 CI 校验。

**7. 修复代码**

`.env` / `.env.example` 删除三行；`app/config.py`：

```python
from pydantic_settings import BaseSettings, SettingsConfigDict

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="forbid",          # 显式保留 fail-fast，避免误配被静默吞掉
    )
    ...
```

新增 CI 步骤（`pytest.ini` 同级加一个冒烟用例）：

```python
# tests/test_config_contract.py
def test_env_example_has_no_unknown_keys():
    """防止 .env.example 与 Settings 漂移（SEC-01 回归）"""
    import re
    from app.config import Settings
    known = set(Settings.model_fields)
    unknown = []
    for line in open(".env.example", encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key = line.split("=", 1)[0].strip()
        if key.lower() not in known:
            unknown.append(key)
    assert not unknown, f".env.example 含 Settings 未声明的键: {unknown}"
```

**8. 回归验证**
- `pytest -q` 能正常收集并执行；
- `uvicorn app.main:app` 启动无 `ValidationError`；
- 在 `.env` 中故意加一个 `FOO_BAR=1`，确认应用**启动失败**（证明 fail-fast 仍生效）。

---

### SEC-02 · 免审自动发布可被规避，原始数据绕过人工审核 【P0 · 安全/逻辑】

**1. 问题位置**
- `app/review.py:242` `_MAX_CANDIDATE_CHARS = 2 * 1024 * 1024`
- `app/review.py:369-393` `extract_comparable_text()`（只读前 2MB）
- `app/review.py:466-503` `decide_export_review()`
- `app/review.py:166-187` `_review_text()`（.txt/.log/.out 无行数/列数硬上限）

**2. 问题类型**：安全（审核绕过 / 数据泄露）

**3. 风险等级**：P0

**4. 触发条件**

`decide_export_review` 对文本类（`.txt`/`.log`/`.out`/`.tsv`/`.dat`）的判定链是：

```
读前 2MB → 算相似度 → < 60% 判 auto → review_result 复核 → 发布
```

而 `_review_text` 只对两种形态拒绝：命中敏感正则、或「总行数 > 500 且纯数字行占比 > 80%」。于是：

- **规避路径 1（大文件截断）**：在 `.txt` 头部填充 ≥ 2MB 的无关文本（如随机英文段落），把真实原始明细追加在其后。相似度只算到 2MB 处 → 命中率极低 → `auto`。同时总行数被填充拉高，纯数字行占比被稀释到 80% 以下 → `_review_text` 放行 → **免审自动发布**。
- **规避路径 2（分片）**：把 1074 行原始明细拆成 4 个 270 行的 `.txt`，每个文件都 < 500 行 → `_review_text` 的行数/占比检查根本不触发；单独看每个分片 token 覆盖率约 50%~60%，略低于阈值即可 `auto` → 4 个文件分别免审发布，下载后拼接即完整原始数据。
- **规避路径 3（列改名 + 换分隔符）**：`line_ratio` 失效后只剩 `token_ratio`，把列名改成中文描述、数值四舍五入，token 覆盖率可压到 60% 以下，而行数保持 ≤ 500 → 放行。

**5. 影响说明**
平台的核心承诺是「原始数据不出域」。该闸门一旦被绕，任意普通用户可在**无管理员介入**的情况下把原始队列数据（612 列 × 1074 行，含医学队列字段）下载到本地，且审计日志只记录一条 `export_auto_approved`，管理员无感知。

**6. 修复建议（四道加固，建议全上）**

1. **规模闸门**：文本类只要「行数 > 50 或 列数 > 10」一律转人工，不再参与免审；
2. **全量读取**：`extract_comparable_text` 不再截断到 2MB，改为读取全文件但设置整体上限（如 50MB，超过直接转人工）；
3. **分片累计**：按 `user_id` 维度统计最近 24h 内免审发布的文本类文件**累计行数**，超过阈值（如 200 行）后续一律转人工；
4. **默认收紧**：把 `EXPORT_REVIEW_SIMILARITY_THRESHOLD` 从 0.6 降到 0.3，并新增 `EXPORT_AUTO_PUBLISH_ENABLED`（生产默认 `false`，即文本类全部转人工）。

**7. 修复代码**

`app/review.py`：

```python
# 新增：免审发布的规模闸门（超过即转人工，不再走 auto）
_AUTO_MAX_TEXT_LINES = 50      # 文本类免审最大行数
_AUTO_MAX_TEXT_COLS  = 10      # 文本类免审最大列数
_MAX_CANDIDATE_BYTES = 50 * 1024 * 1024   # 超过该体积直接转人工

def _text_shape(path: str) -> tuple[int, int]:
    """返回 (行数, 最大列数)；用于免审规模闸门"""
    lines, maxcols = 0, 0
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            lines += 1
            if lines > _AUTO_MAX_TEXT_LINES * 10:   # 早停
                return lines, maxcols
            maxcols = max(maxcols, len(line.split(",")))
    return lines, maxcols


def extract_comparable_text(file_path: str) -> str | None:
    ext = os.path.splitext(file_path)[1].lower()
    if ext in _TEXT_EXTS:
        size = os.path.getsize(file_path)
        if size > _MAX_CANDIDATE_BYTES:          # ① 超大文件不再截断，直接无法判定
            return None
        with open(file_path, "rb") as f:
            raw = f.read()                        # ② 全量读取，杜绝"头部填充"稀释
        if _looks_binary(raw):
            return None
        return _decode_bytes(raw)
    if ext == ".xlsx":
        return _extract_xlsx_text(file_path)
    return None
```

`decide_export_review` 中在返回 `auto` 前插入规模闸门：

```python
    # 4. 文本类：相似度比对 + 编码混淆防护
    score, detail = similarity_to_dataset(file_path)
    if score is None:
        return "review", detail, None
    if score >= thr:
        return "review", f"{detail}，达到/超过阈值 {thr*100:.0f}%，需管理员审核", score

    # ---- 新增：免审规模闸门（SEC-02）----
    lines, cols = _text_shape(file_path)
    if lines > _AUTO_MAX_TEXT_LINES or cols > _AUTO_MAX_TEXT_COLS:
        return ("review",
                f"文本规模超免审上限（{lines} 行 / {cols} 列），转管理员人工审核", score)
    if not _auto_quota_ok(file_path, lines):      # 分片累计配额
        return ("review", "近期免审导出量已达上限，转管理员人工审核", score)

    return "auto", f"{detail}，低于阈值 {thr*100:.0f}%，免审核自动通过", score
```

分片累计配额（放 `app/review.py` 或独立 `app/export_quota.py`，用 Redis/DB 均可）：

```python
def _auto_quota_ok(file_path: str, lines: int, window_hours: int = 24,
                   max_lines: int = 200) -> bool:
    """同一用户 24h 内免审发布的文本行数累计配额（防分片规避）"""
    from app.database import SessionLocal
    from app.models import PendingFile
    from datetime import datetime, timedelta
    from sqlalchemy import func
    db = SessionLocal()
    try:
        # 以 file_path 反推 user_id：生产建议改为显式传入 user_id
        uid = _owner_of(file_path)
        if uid is None:
            return True
        total = db.query(func.count(PendingFile.id)).filter(
            PendingFile.user_id == uid,
            PendingFile.status == "approved",
            PendingFile.review_reason.like("%免审核自动通过%"),
            PendingFile.reviewed_at >= datetime.utcnow() - timedelta(hours=window_hours),
        ).scalar() or 0
        return (total * lines) <= max_lines
    finally:
        db.close()
```

**8. 回归验证**
- 新增用例：构造「2MB 填充 + 原始明细」的 `.txt`，断言 `decide_export_review` 返回 `review` 而非 `auto`；
- 新增用例：4 个 270 行分片，断言第 2 个起转为 `review`（配额生效）；
- 新增用例：30 行 × 8 列的正常统计结果 `.csv`，断言仍为 `auto`（不误伤）；
- 手工验证：把一个 1074 行原始明细 `.txt` 放进 pending，走完流程确认出现在「待审核」而非「已发布」。

---

### LOG-01 · 管理员直接下发数据必抛 500（模型字段不存在）【P0 · 逻辑】

**1. 问题位置**
- `app/routers/data.py:184-191`（无 `apply_id` 分支）
- `app/models.py:105-122`（`DataApply` 无 `target_user_id` 列）

**2. 问题类型**：逻辑（功能阻断）

**3. 风险等级**：P0

**4. 触发条件（已实测）**

```python
>>> M(user_id=1, target_user_id=1)      # SQLAlchemy declarative 构造
TypeError: 'target_user_id' is an invalid keyword argument for M
```

调用链：`POST /data/generate` 且 `apply_id` 为空/0。
前端 `DataFilter.vue:143` 传的是 `apply_id: Number(applyId)`：
- 管理员从「待处理数据申请」页跳转 → `applyId` 有值，正常；
- 管理员直接打开「数据筛选与生成」页 → `applyId` 为空 → `Number('') === 0` → pydantic 收到 `0` → `if payload.apply_id:` 为 False → 进入 else 分支 → **500**。

**5. 影响说明**
「管理员主动下发数据（不走用户申请）」这条主流程 100% 不可用。更严重的是它暴露了质量门禁失效：`tests/test_data_fetch.py` 有 9 处 `target_user_id` 断言，但没有一条覆盖"不传 apply_id"的分支。

**6. 修复建议**
二选一：
- **A（推荐，最小改动）**：删除构造参数中的 `target_user_id`（该字段本就是冗余，`user_id` 已表达归属）。
- **B（保留语义）**：在 `DataApply` 上补 `target_user_id` 列并加迁移。鉴于 `applies.py:_to_dict` 已经用 `"target_user_id": a.user_id` 做了映射，A 方案足够且更简洁。

同时修复前端：明确传 `null` 而非 `0`。

**7. 修复代码**

`app/routers/data.py`：

```python
    else:
        # 管理员直接分配——自动建一条申请记录作为分配痕迹
        apply_obj = DataApply(
            user_id=target.id,
            # 修复 LOG-01：ORM 无 target_user_id 列，传入会导致 TypeError -> 500
            purpose="管理员直接分配",
            priority="medium",
            status="processing",
            processed_by=admin.id,
        )
```

`frontend/src/views/admin/DataFilter.vue`：

```ts
const res = await generateFilteredData({
  filters: filters.value,
  target_user_id: targetUserId.value,
  filename: finalName,
  // 修复 LOG-01：applyId 为空时传 null，避免 Number('') === 0 被当作无效 ID
  apply_id: applyId ? Number(applyId) : null,
})
```

**8. 回归验证**
- 新增用例 `test_generate_without_apply_id_returns_202`：不传 `apply_id` 调 `/data/generate`，断言返回 `status == "generating"`；
- 新增用例断言自动创建的 `DataApply.purpose == "管理员直接分配"`；
- 手工：管理员空筛选给某用户生成一次全量数据，确认生成成功并收到站内消息。

---

### SEC-03 · 相似度基线与实际下发数据源不一致 【P1 · 安全/逻辑】

**1. 问题位置**
- `app/config.py:36` `dataset_csv_path: str = "testData.csv"`（比对基线）
- `app/config.py:41` `testdata_table: str = "test_data"`（实际下发源）
- `app/review.py:421` `_load_baseline(baseline_path or _settings.dataset_csv_path)`

**2. 问题类型**：安全（控制失效）

**3. 风险等级**：P1

**4. 触发条件**
管理员从 `test_data` 宽表筛选生成 Excel 下发到用户 W: 盘；用户把该 Excel（或另存的 CSV）放回 pending 申请导出；系统拿 `testData.csv` 做基线比对。若两者：
- 列集合不同（宽表 vs CSV）、
- 编码/格式不同（宽表数值型 vs CSV 字符串）、
- 或者 `testData.csv` 是旧快照而宽表已更新，

则相似度会显著偏低 → 判 `auto` → **用户导出的正是系统下发给他本人的原始数据，却走了免审**。

**5. 影响说明**
免审判定的"参照系"与"被保护对象"不是同一份数据，判定结论不可信；且这种失败是**静默**的——管理员不会收到任何提示。

**6. 修复建议**
- 把基线改为「与实际下发同源」：优先用 `settings.testdata_table` 生成/维护基线，或让 `/data/import` 导入时就同步刷新基线；
- 启动时校验「基线存在且非空」，缺失时**直接关闭免审自动发布**（而不是每条转人工——转人工会淹没管理员队列）；
- 暴露一个自检接口 `GET /admin/review-baseline` 返回基线路径、行数、更新时间。

**7. 修复代码**

`app/config.py` 新增：

```python
    # 免审自动发布总开关：基线不可信/生产环境建议关闭，文本类一律转人工
    export_auto_publish_enabled: bool = False
    # 相似度基线：留空则取 dataset_csv_path
    export_baseline_path: str = ""
```

`app/review.py`：

```python
def _baseline_path() -> str:
    return _settings.export_baseline_path or _settings.dataset_csv_path


def decide_export_review(file_path: str, threshold: float | None = None):
    thr = _settings.export_review_similarity_threshold if threshold is None else threshold
    ext = os.path.splitext(file_path)[1].lower()
    ...
    # 4. 文本类
    if not _settings.export_auto_publish_enabled:        # ① 总开关
        return ("review", "免审自动发布已关闭，转管理员人工审核", None)
    if not os.path.exists(_baseline_path()):             # ② 基线缺失告警
        logger.error("相似度基线缺失: %s —— 免审判定已停用", _baseline_path())
        return ("review", "相似度基线缺失，转管理员人工审核", None)
    ...
```

**8. 回归验证**
- 用例 A：`export_auto_publish_enabled=False` 时，低相似度 `.csv` 断言返回 `review`；
- 用例 B：基线文件不存在时，断言返回 `review` 且日志出现 ERROR；
- 运维核对：`GET /admin/review-baseline` 返回的列集合与 `test_data` 宽表 `information_schema.columns` 一致。

---

### LOG-02 · 驳回与通过并发导致状态撕裂 【P1 · 逻辑】

**1. 问题位置**
- `app/routers/admin.py:195-220` `reject_pending`（无 `with_for_update`、无条件更新）
- 对比 `app/routers/admin.py:98-181` `approve_pending`（有行锁 + 条件更新）

**2. 问题类型**：逻辑（并发 / 状态不一致）

**3. 风险等级**：P1

**4. 触发条件**

```
T1 管理员 A  GET /admin/pending 看到 #12 (pending)
T2 管理员 A  POST /admin/pending/12/reject  → 读到 pf.status == 'pending' ✓
T3 管理员 B  POST /admin/pending/12/approve → 条件更新 pending→approved 成功
             → 复制文件到 published，创建 ExportResult（用户已可下载）
T4 管理员 A  pf.status = 'rejected'; db.commit()   ← 覆盖了 B 的结果
```

最终：`pending_files.status = rejected`，但 `export_results` 里有一条可用记录，`published/12/` 有文件，用户能下载。**驳回决定被静默推翻**，且审计日志里 approve 与 reject 各一条，无法自洽。

同类型的还有：`reject` 之后 `approve` 仍可执行（因为 approve 用条件更新，但 reject 已提交，条件不满足 → OK）；反过来 `approve` 之后 `reject` 却可以（无状态条件）。

**5. 影响说明**
审批结论不可信：被驳回的导出实际对外可下载；审计日志出现自相矛盾的两条记录，事后追溯无法确定真实结论。

**6. 修复建议**
把 `reject_pending` 改成与 `approve_pending` 同构：行锁 + **条件更新认领**（`UPDATE ... WHERE status='pending'` + `rowcount == 1`）。

**7. 修复代码**

```python
@router.post("/pending/{pending_id}/reject")
def reject_pending(pending_id: int, req: ExportReviewRequest, request: Request,
                   admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    pf = db.query(PendingFile).filter(
        PendingFile.id == pending_id
    ).with_for_update().first()          # ① 行锁（PG 生效，SQLite no-op）
    if pf is None:
        raise HTTPException(status_code=404, detail="申请不存在")
    if pf.status != "pending":
        raise HTTPException(status_code=400, detail="该申请已处理")

    # ② 条件更新认领：并发下只有一个请求能拿到 rowcount==1
    claimed = db.query(PendingFile).filter(
        PendingFile.id == pending_id,
        PendingFile.status == "pending",
    ).update({"status": "rejected"}, synchronize_session=False)
    if claimed != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="该申请已被其他管理员处理，请刷新列表")
    pf.status = "rejected"
    pf.review_reason = req.reason or "审核拒绝"
    pf.reviewed_by = admin.id
    pf.reviewed_at = datetime.utcnow()

    db.add(AuditLog(user_id=admin.id, action="export_rejected",
                    detail=f"审核拒绝导出申请 {pf.file_name} (id={pending_id}, 用户id={pf.user_id}): {pf.review_reason}",
                    ip_addr=get_client_ip(request)))
    db.commit()
    db.refresh(pf)
    return PendingFileOut.model_validate(pf)
```

**8. 回归验证**
- 新增并发用例：两个线程同时对同一 pending 调 approve 与 reject，断言有且仅有一个返回 2xx，另一个返回 409；
- 断言 `export_results` 记录数与 `pending_files.status` 一致（approve 成功则 1 条 + approved；reject 成功则 0 条 + rejected）；
- 手工：两个浏览器窗口同时操作同一申请，观察其中一个提示"已被其他管理员处理"。

---

### LOG-03 · 生成中申请可被驳回，任务完成后状态被回退 【P1 · 逻辑】

**1. 问题位置**
- `app/routers/applies.py:162-171` `admin_reject_apply` 仅拒绝 `completed`
- `app/routers/data.py:293` `_run_generate_job` 成功路径无条件 `apply_obj.status = "completed"`

**2. 问题类型**：逻辑（状态机缺陷）

**3. 风险等级**：P1

**4. 触发条件**

```
T1 管理员 POST /data/generate → 申请置 generating，后台线程开始生成（可能耗时数分钟）
T2 管理员改变主意 POST /admin/data-applies/{id}/reject → 状态置 rejected，用户收到"被驳回"消息
T3 后台线程完成：Excel 已生成、已 SFTP 推送到用户 W: 盘、站内消息"数据已生成"
   → apply_obj.status = "completed"   ← 驳回结论被覆盖
```

**5. 影响说明**
- 驳回决定形同虚设：用户实际已拿到全量数据（文件已在 W: 盘，可直接使用），但申请记录显示 completed 而非 rejected；
- 反向也成立：申请 `failed` 后管理员重新生成，旧任务若仍在跑会二次覆盖；
- 管理员看到的队列状态与真实情况不符，审计链路断裂。

**6. 修复建议**
1. 状态机加硬约束：`generating` 为**不可驳回**状态，驳回前先取消任务；
2. 后台任务完成时用**条件更新**认领终态：`UPDATE ... WHERE status='generating' AND id=:id`，rowcount != 1 说明已被驳回/接管，直接放弃写回并告警；
3. 任务启动前记录 `job_token`（uuid），完成时校验 token 未变更。

**7. 修复代码**

`app/routers/applies.py`：

```python
# 不可被驳回的终态/进行中状态
_UNREJECTABLE = {"generating", "completed"}

@router.post("/admin/data-applies/{apply_id}/reject")
def admin_reject_apply(...):
    ...
    if apply_obj.status in _UNREJECTABLE:
        raise HTTPException(
            status_code=409,
            detail=f"申请当前状态为「{apply_obj.status}」，无法驳回"
                   f"（生成中请先等待任务结束或联系管理员终止）",
        )
    # 条件更新认领，防并发
    claimed = db.query(DataApply).filter(
        DataApply.id == apply_id,
        DataApply.status.notin_(list(_UNREJECTABLE)),
    ).update({"status": "rejected"}, synchronize_session=False)
    if claimed != 1:
        db.rollback()
        raise HTTPException(status_code=409, detail="申请状态已变更，请刷新后重试")
```

`app/routers/data.py::_run_generate_job` 完成处：

```python
        # 条件更新认领终态：若期间被驳回/被他人接管，放弃写回（LOG-03）
        claimed = db.query(DataApply).filter(
            DataApply.id == apply_id,
            DataApply.status == "generating",
        ).update({"status": "completed", "finished_at": datetime.utcnow()},
                 synchronize_session=False)
        if claimed != 1:
            db.rollback()
            logger.warning("申请 #%s 在生成期间状态已变更，放弃写回 completed", apply_id)
            db.add(AuditLog(user_id=admin_id, action="data_generate",
                            detail=f"后台生成完成但申请 #{apply_id} 状态已变更，未写回",
                            status="failed", ip_addr=client_ip))
            db.commit()
            return
        # 只有认领成功才发消息、推文件
        ...
```

**8. 回归验证**
- 用例：把申请置 `generating`，调 reject 断言 409；
- 用例：模拟任务执行期间把申请改成 `rejected`，任务结束后断言状态仍为 `rejected` 且未生成 `Message`；
- 用例：正常流程断言 `completed` + 站内消息存在。

---

### SEC-04 · X-Forwarded-For 无条件信任 → 限流绕过与审计污染 【P1 · 安全】

**1. 问题位置**
- `app/rate_limit.py:50-56` `get_client_ip()`
- `nginx/stats-platform.conf`（`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`）

**2. 问题类型**：安全（认证绕过 / 日志完整性）

**3. 风险等级**：P1

**4. 触发条件**

```bash
curl -X POST https://<domain>/auth/login \
     -H "X-Forwarded-For: 1.2.3.4" -d '{"username":"admin","password":"..."}'
```

nginx 的 `$proxy_add_x_forwarded_for` 会**追加**而非覆盖，结果是 `1.2.3.4, <真实IP>`；`get_client_ip` 取 `split(",")[0]` → 拿到攻击者伪造的 `1.2.3.4`。

后果：
- 每换一个 `X-Forwarded-For` 就是一个新的限流桶 → 登录爆破限流（5 次/60s）与注册限流（3 次/300s）**完全失效**；
- 审计日志 `ip_addr` 被污染 → 事后追查完全错误，且攻击者可把操作嫁祸给任意 IP。

**5. 影响说明**
演示账号弱密码（SEC-11）+ 限流绕过 = 管理员账号可被在线爆破拿下；拿下 admin 即可审批任意导出。审计日志作为平台唯一的追溯手段，其 IP 字段不可信。

**6. 修复建议**
- 只在「可信代理」前提下解析 XFF，且从**右往左**跳过已知代理段取真实客户端；
- 引入 `TRUSTED_PROXY_HOPS` 配置（nginx 反代场景为 1）；
- 保留 `request.client.host` 作为兜底，同时把原始头写入审计的 `detail` 备查。

**7. 修复代码**

`app/config.py` 新增：

```python
    # 可信反向代理层数（nginx 直连后端 = 1）；0 表示不信任 XFF
    trusted_proxy_hops: int = 1
```

`app/rate_limit.py`：

```python
def get_client_ip(request: Request) -> str:
    """在明确的可信代理层数下解析 X-Forwarded-For，防止伪造（SEC-04）。

    XFF 形如 "client, proxy1, proxy2"；从右往左跳过 trusted_proxy_hops 个
    已知代理段后，最右侧剩余项即为真实客户端。不信任时直接取 TCP 对端地址。
    """
    hops = max(int(settings.trusted_proxy_hops or 0), 0)
    if hops > 0:
        forwarded = request.headers.get("x-forwarded-for", "")
        parts = [p.strip() for p in forwarded.split(",") if p.strip()]
        if len(parts) >= hops:
            return parts[-hops] if len(parts) == hops else parts[max(len(parts) - hops - 1, 0)]
    return request.client.host if request.client else "unknown"
```

> 更稳妥的做法是在 nginx 侧用 `real_ip` 模块把 `$remote_addr` 直接改写为真实客户端，后端只信 `request.client.host`。两者可同时做。

nginx 侧加固：

```nginx
set_real_ip_from 127.0.0.1;
real_ip_header X-Forwarded-For;
real_ip_recursive on;
```

**8. 回归验证**
- 用例：伪造 `X-Forwarded-For: 9.9.9.9`（单段，hops=1）断言 `get_client_ip` 返回真实 client host；
- 用例：连续 6 次带不同 XFF 的登录请求，断言第 6 次返回 429（限流未被绕过）；
- 检查审计日志 `ip_addr` 与 nginx access log 的 `$remote_addr` 一致。

---

### SEC-05 / PERF-01 · request-export 无防护且实现低效 【P1 · 安全+性能】

**1. 问题位置**
- `app/routers/results.py:147-275` `request_export`
- `app/transfer.py:153-186`（`list_remote_files` / `download_file_from_windows` 每次新建 SSH 连接）

**2. 问题类型**：安全（DoS）+ 性能

**3. 风险等级**：P1

**4. 触发条件**
用户在 Windows pending 目录放 N 个文件（可以是任意大小，无任何上限），然后反复点击「申请导出」：

- 每次调用：`list_remote_files` 建 1 条 SSH + 每个待下载文件再建 1 条 SSH → **N+1 条 TCP+SSH 握手**；
- 每次调用：对 pending 目录下**所有**文件做全量 SHA256（不管是否已申请过）；
- 无接口限流，无幂等键，无文件数量/体积上限。

**5. 影响说明**
- 单个用户即可打满 Windows 主机的 SSH 连接数与磁盘 IO，影响所有用户的远程桌面与数据下发；
- FastAPI 请求线程被长任务占满（该接口是同步 `def`，在线程池执行），连带登录等短请求超时；
- 无体积上限意味着用户可以放一个 10GB 文件，服务端磁盘被撑爆。

**6. 修复建议**
1. 接口级限流（如每用户 1 次/30s + 6 次/10min）；
2. 单次拉取文件数量上限（如 50 个）、单文件体积上限（如 200MB）、目录总体积上限；
3. SSH 连接复用：一次连接内完成 list + 全部下载；
4. SHA256 结果按 `(path, mtime, size)` 缓存，避免重复计算；
5. 加 `Idempotency-Key` 或直接对「10 秒内的重复请求」返回上次结果。

**7. 修复代码**

```python
# app/rate_limit.py 追加
def rate_limit_export(request: Request, user=Depends(get_current_user)) -> None:
    if not settings.rate_limit_enabled:
        return
    key = f"export:{user.id}"
    allowed, wait = _limiter.check(key, max_attempts=1, window_seconds=30)
    if not allowed:
        raise HTTPException(status_code=429, detail=f"导出申请过于频繁，请 {wait} 秒后重试")
```

```python
# app/transfer.py：一次连接完成批量下载
def download_files_batch(remote_dir: str, names: list[str],
                         local_dir: str, max_bytes: int) -> list[str]:
    sftp, ssh = _connect_sftp()
    pulled = []
    try:
        for name in names:
            try:
                st = sftp.stat(f"{remote_dir.rstrip('/')}/{name}")
            except (IOError, OSError):
                continue
            if stat_mod.S_ISDIR(st.st_mode) or st.st_size > max_bytes:
                continue
            local_path = os.path.join(local_dir, name)
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            sftp.get(f"{remote_dir.rstrip('/')}/{name}", local_path)
            pulled.append(local_path)
        return pulled
    finally:
        sftp.close(); ssh.close()
```

```python
# app/routers/results.py：常量与上限
_MAX_PENDING_FILES = 50
_MAX_PENDING_FILE_BYTES = 200 * 1024 * 1024
```

**8. 回归验证**
- 用例：连续两次调 `/results/request-export`，第二次断言 429；
- 用例：pending 目录放 100 个文件，断言只处理前 50 个并在响应中给出 `truncated` 标记；
- 压测：10 并发 × 20 次导出申请，观察 Windows 主机 SSH 连接数峰值 ≤ 2（连接复用生效），P95 响应时间下降。

---

### SEC-06 · 管理员可把投递目录指向 Windows 任意路径 【P1 · 安全】

**1. 问题位置**
- `app/routers/admin.py:274` `_PLATFORM_CONFIG_KEYS` 含 `workspace_dir`
- `app/routers/admin.py:325-370` `put_platform_config`（只校验 `host`，不校验路径）
- `app/routers/data.py:286` `get_workspace_root()` → 直接拼进 SFTP 目标路径

**2. 问题类型**：安全（越权写 / 权限提升）

**3. 风险等级**：P1

**4. 触发条件**
任意 `admin`（非 superadmin）调用：

```json
PUT /admin/platform-config
{"host": "10.0.0.5", "workspace_dir": "C:/Windows/System32", "output_path": "C:/"}
```

`_is_allowed_test_host` 只检查 host；`workspace_dir` 无任何校验。随后管理员执行一次"生成数据"，`upload_file_to_windows` 会把 Excel 写到 `C:/Windows/System32/{用户名}/`，并执行：

```
icacls "C:\Windows\System32" /inheritance:r /grant:r "user1:(OI)(CI)F" ...
```

即把系统目录的所有权授予普通用户 —— 可导致 Windows 主机被完全接管（进而绕过所有 RDS/ACL 隔离，读取他人 W: 盘与 Z: 盘）。

**5. 影响说明**
`admin` 角色的实际权限被放大为「Windows 主机任意路径写 + ACL 改写」，远超其业务职责；这是一条从应用层直接击穿主机层隔离的通路。

**6. 修复建议**
- 对 `workspace_dir` / `output_path` 做**路径前缀白名单**：必须以 `C:/workspace`、`C:/pending`、`C:/StatsData`（或运维显式配置的 `ALLOWED_WINDOWS_PATH_PREFIXES`）开头，且不含 `..`；
- `icacls` 锁定前再校验一次目标路径必须在允许前缀内，否则跳过锁定并告警；
- 敏感路径（System32 / Program Files / Windows / 盘根目录）显式拉黑。

**7. 修复代码**

```python
# app/config.py
    # 允许的 Windows 投递路径前缀（逗号分隔），留空则用内置默认值
    allowed_windows_path_prefixes: str = "C:/workspace,C:/pending,C:/StatsData"

_WINDOWS_PATH_DENY = ("system32", "syswow64", "program files", "windows", "$recycle.bin")

def _validate_windows_dir(path: str, settings) -> str:
    p = (path or "").strip().replace("\\", "/").rstrip("/")
    if not p:
        return p
    if ".." in p.split("/"):
        raise HTTPException(status_code=400, detail="投递路径不允许包含 '..'")
    lowered = p.lower()
    if any(seg in _WINDOWS_PATH_DENY for seg in lowered.split("/")):
        raise HTTPException(status_code=400, detail=f"投递路径命中系统目录黑名单: {path}")
    prefixes = [s.strip().replace("\\", "/") for s in
                (settings.allowed_windows_path_prefixes or "").split(",") if s.strip()]
    if prefixes and not any(lowered.startswith(pre.lower()) for pre in prefixes):
        raise HTTPException(
            status_code=400,
            detail=f"投递路径不在允许前缀内（允许: {', '.join(prefixes)}）",
        )
    return p
```

在 `put_platform_config` 中调用：

```python
    values = {
        "host": req.host.strip(),
        "port": str(req.port),
        "username": req.username.strip(),
        "workspace_dir": _validate_windows_dir(req.workspace_dir, settings),
        "output_path": _validate_windows_dir(req.output_path, settings),
    }
```

`app/transfer.py::upload_file_to_windows` 增加二次校验（防止 PlatformConfig 被其他途径写入脏值）：

```python
    from app.routers.admin import _validate_windows_dir
    target_dir = _validate_windows_dir(remote_dir or settings.windows_data_dir, settings)
```

**8. 回归验证**
- 用例：`workspace_dir="C:/Windows/System32"` 断言 400；
- 用例：`workspace_dir="C:/workspace/../Windows"` 断言 400；
- 用例：`workspace_dir="C:/workspace"` 断言 200 且落库正确；
- 用例：直接往 `platform_config` 表塞脏值，再触发一次生成，断言 `upload_file_to_windows` 拒绝并写审计。

---

### SEC-07 · SPA 回退中间件绕过安全响应头 【P2 · 安全】

**1. 问题位置**
- `app/main.py:239-250` `security_headers` 中间件
- `app/main.py:278-292` `spa_history_fallback` 中间件

**2. 问题类型**：安全（纵深防御失效）

**3. 风险等级**：P2

**4. 触发条件**
Starlette `add_middleware` 的实现是 `self.user_middleware.insert(0, ...)`（已核对 `.venv/Lib/site-packages/starlette/applications.py:107`），即**后注册的中间件在更外层**。注册顺序为：

```
1. CORSMiddleware        → [CORS]
2. security_headers      → [security, CORS]
3. spa_history_fallback  → [spa, security, CORS]
```

`build_middleware_stack` 对列表 `reversed()` 后由内向外包裹，因此**最先插入的最外层** = `spa_history_fallback`。

于是：`spa_history_fallback` 对 `GET` + `Accept: text/html` 直接 `return FileResponse(_SPA_INDEX)`，**不再调用 `call_next`**，安全头中间件根本不会执行。

验证方式：`curl -sI https://<domain>/ -H 'Accept: text/html'` 应看不到 `Content-Security-Policy`。

**5. 影响说明**
最需要 CSP 保护的页面（`index.html`，所有用户主入口）恰好没有 CSP。`main.py:235-238` 的注释明确指出「Token 存 localStorage 的现状下，CSP 是 XSS 窃取令牌的纵深防御」——这条防线在最关键的位置是缺的。

**6. 修复建议**
把安全头的设置移到**最外层**：在 `spa_history_fallback` 中直接复用同一个函数，或把 `security_headers` 改为最后注册。

推荐做法：抽出 `_apply_security_headers(response)` 函数，两处都调用。

**7. 修复代码**

```python
# app/main.py
def _apply_security_headers(response) -> None:
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; font-src 'self' data:; connect-src 'self'; "
        "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    )
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("Referrer-Policy", "same-origin")
    response.headers.setdefault("X-Frame-Options", "DENY")
    return response


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    return _apply_security_headers(response)

# ...（注册顺序在 spa 之后，即实际更外层）

@app.middleware("http")
async def spa_history_fallback(request: Request, call_next):
    accept = request.headers.get("accept", "")
    if request.method == "GET" and "text/html" in accept:
        path = request.url.path
        if not path.startswith(("/docs", "/redoc", "/openapi.json", "/assets", "/static", "/health")):
            return _apply_security_headers(FileResponse(_SPA_INDEX))   # ← 关键
    return await call_next(request)
```

**8. 回归验证**
- `curl -sI https://<domain>/ -H 'Accept: text/html'` 断言响应含 `Content-Security-Policy` 与 `X-Frame-Options`；
- 浏览器打开首页，DevTools → Network → 文档请求，确认响应头齐全；
- 断言 API 响应头仍正常（未重复设置）。

---

### SEC-08 · SSH/SFTP 主机密钥不校验 【P2 · 安全】

**1. 问题位置**：`app/transfer.py:47`、`app/routers/admin.py:418`（均 `AutoAddPolicy()`）

**2. 问题类型**：安全（传输安全）

**3. 风险等级**：P2

**4. 触发条件**
`connect_ssh()` 每次连接都接受任意主机密钥并写入 `known_hosts`。若攻击者在同一内网做 ARP/DNS 欺骗或控制了中间设备，可冒充 Windows 云主机，截获：
- 管理员在「测试连接」中输入的 Windows 账号密码（`admin.py:420-428`）；
- 生成的含原始数据的 Excel（`upload_file_to_windows`）。

**5. 影响说明**
内网 MITM 成本不高，而传输内容是全量业务数据 + 管理员凭据。

**6. 修复建议**
改为 `RejectPolicy` + 预置 `known_hosts`（或读取 `SSH_KNOWN_HOSTS_FILE`），首次部署由运维用 `ssh-keyscan` 生成。

**7. 修复代码**

```python
# app/config.py
    ssh_known_hosts_path: str = "~/.ssh/known_hosts"

# app/transfer.py
def connect_ssh() -> paramiko.SSHClient:
    ...
    ssh = paramiko.SSHClient()
    known = os.path.expanduser(settings.ssh_known_hosts_path)
    if os.path.exists(known):
        ssh.load_host_keys(known)
        ssh.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        logger.warning("known_hosts 不存在(%s)，回退 AutoAddPolicy（仅允许首次部署）", known)
        ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(...)
```

**8. 回归验证**
- 用例：monkeypatch 一个不同主机密钥，断言连接抛 `SSHException`；
- 部署清单增加一步：`ssh-keyscan -H <windows-host> >> ~/.ssh/known_hosts`。

---

### SEC-09 · 缺少账号停用/封禁能力 【P2 · 安全/运营】

**1. 问题位置**：`app/routers/admin.py`（只有角色管理，无 `is_active` 管理）；`app/models.py:19` 有 `is_active` 字段但无写入路径

**2. 问题类型**：安全（身份生命周期）

**3. 风险等级**：P2

**4. 触发条件**
人员离职/转岗后，管理员无法在平台停用账号；该用户的 JWT 最长仍可用 8 小时，且只要密码未改即可无限续期。同时其 Windows 本地账号、Guacamole 账号、W:/pending 目录全部保留。

**5. 影响说明**
僵尸账号长期有效，且平台账号/Windows 账号/Guacamole 账号三处需分别手工清理，容易遗漏。

**6. 修复建议**
- 新增 `PUT /admin/manage/users/{id}/active`（superadmin 或 admin），禁用时同步 `password_version += 1` 使在飞 JWT 立即失效；
- 禁用时可选联动：禁用 Guacamole 用户（`UPDATE guacamole_user SET disabled=TRUE`）、禁用 Windows 本地账号（`Disable-LocalUser`）；
- 列表页增加 `is_active` 筛选。

**7. 修复代码**

```python
class ActiveUpdateRequest(BaseModel):
    is_active: bool
    disable_external: bool = True

@router.put("/manage/users/{user_id}/active", response_model=UserAdminOut)
def set_user_active(user_id: int, req: ActiveUpdateRequest, request: Request,
                    admin: User = Depends(require_admin), db: Session = Depends(get_db)):
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="不能停用自己")
    user = db.query(User).filter(User.id == user_id).first()
    if not user:
        raise HTTPException(status_code=404, detail="用户不存在")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="超级管理员账号只能由服务器命令管理")
    if user.is_active == req.is_active:
        return user

    user.is_active = req.is_active
    user.password_version = (user.password_version or 1) + 1   # 在飞 JWT 立即失效
    detail = f"{'启用' if req.is_active else '停用'}用户 {user.username}(id={user_id})"

    if not req.is_active and req.disable_external:
        try:
            from app.guac import set_guac_user_disabled
            set_guac_user_disabled(user.username, True)
            from app.windows_account import set_windows_user_disabled
            set_windows_user_disabled(user.username, True)
            detail += "（已同步停用 Guacamole / Windows 账号）"
        except Exception as exc:                      # 外部失败不阻断平台停用
            detail += f"（外部账号停用失败: {exc}）"
            logger.warning("外部账号停用失败 user=%s: %s", user.username, exc)

    db.add(AuditLog(user_id=admin.id, action="set_user_active",
                    detail=detail, ip_addr=get_client_ip(request)))
    db.commit(); db.refresh(user)
    return user
```

**8. 回归验证**
- 用例：停用后该用户 token 调 `/auth/me` 断言 401；
- 用例：停用后 Guacamole `guacamole_user.disabled == TRUE`；
- 用例：admin 不能停用自己、不能停用 superadmin。

---

### SEC-10 · JWT 无法吊销 / 登出不生效 【P2 · 安全】

**1. 问题位置**
- `app/auth.py:114-122` `create_access_token`（无 `jti`、无 `iat`/`nbf`）
- `app/auth.py:125-155` `get_current_user`（只查库，无黑名单）
- `frontend/src/stores/user.ts:26-30` `logout()` 仅清 localStorage

**2. 问题类型**：安全（会话管理）

**3. 风险等级**：P2

**4. 触发条件**
用户点「退出登录」后，token 仍在有效期内（默认 8 小时），任何拿到该 token 的人可继续使用，直至过期或管理员改密/改角色。

**5. 影响说明**
公共电脑/共享终端场景下风险明显；令牌泄露后无应急吊销手段（只能改密，影响用户本人）。

**6. 修复建议**
- token 增加 `jti` + `iat`；
- 维护一个 Redis/DB 的 token 黑名单（登出时写入 `jti`，剩余 TTL）；
- 缩短有效期到 2 小时 + 提供 refresh token；
- 前端登出时调用 `POST /auth/logout` 通知后端。

**7. 修复代码**

```python
import uuid
def create_access_token(user_id, username, role, password_version=1) -> tuple[str, str]:
    jti = uuid.uuid4().hex
    payload = {
        "sub": str(user_id), "username": username, "role": role,
        "pwd_ver": password_version, "jti": jti,
        "iat": datetime.utcnow(),
        "exp": datetime.utcnow() + timedelta(hours=settings.jwt_expire_hours),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm), jti


# 登出：把 jti 写入黑名单，TTL = token 剩余寿命
def revoke_token(jti: str, exp_epoch: int) -> None:
    ttl = max(int(exp_epoch - time.time()), 1)
    token_blacklist.set(jti, "1", ex=ttl)     # Redis；无 Redis 可用 DB 表 + 定时清理
```

`get_current_user` 中在校验签名后增加：

```python
    jti = payload.get("jti")
    if jti and token_blacklist.exists(jti):
        raise HTTPException(status_code=401, detail="令牌已失效，请重新登录")
```

**8. 回归验证**
- 用例：登出后用原 token 调 `/auth/me` 断言 401；
- 用例：黑名单 TTL 到期后 key 自动消失（不会无限增长）。

---

### SEC-11 · 演示账号弱密码与资产信息明文入库 【P2 · 安全】

**1. 问题位置**
- `.env:12-13` `DEMO_ADMIN_PASSWORD=admin123`、`DEMO_USER_PASSWORD=user123`
- `README.md:107` 演示账号密码明文
- `README.md:268/336` 生产主机 IP `8.133.223.251`、域名 `chunjindevelop68.xyz`
- `.env:21/29` 同上

**2. 问题类型**：安全（凭据与资产暴露）

**3. 风险等级**：P2

**4. 触发条件**
`.env` 已被 `.gitignore` 排除（这点做得对），但 README 与 `guacamole/` 配置中的明文 IP/域名是**入库**的；演示密码 `admin123` 是字典首屏词，配合 SEC-04 的限流绕过可被爆破。

**5. 影响说明**
资产指纹暴露降低攻击成本；弱口令 + 限流绕过 = 管理员账号失守。

**6. 修复建议**
- README 中所有 IP/域名改为 `<WINDOWS_HOST>` / `<DOMAIN>` 占位；
- `.env.example` 中演示密码留空并加注释「生产必须留空」；
- 启动校验：生产环境（`APP_ENV=prod`）若检测到 `DEMO_ADMIN_PASSWORD` 长度 < 12 或未满足密码策略，直接启动失败或强制禁用演示账号。

**7. 修复代码**

```python
# app/auth.py 末尾
def _assert_demo_password_strength():
    if settings.app_env.strip().lower() != "prod":
        return
    for name, pw in DEMO_USERS.items():
        try:
            validate_password_strength(pw, name)
        except ValueError as exc:
            raise RuntimeError(
                f"生产环境演示账号 {name} 密码不满足强度策略: {exc}；"
                f"请设置强密码或直接留空禁用演示账号"
            ) from exc

_assert_demo_password_strength()
```

**8. 回归验证**
- `grep -rn "8\.133\.223\.251" README.md guacamole/ nginx/` 应无结果（或仅占位符）；
- 用例：`APP_ENV=prod` + `DEMO_ADMIN_PASSWORD=admin123` 断言导入 `app.auth` 抛 RuntimeError。

---

### SEC-12 / CODE-04 / CODE-05 / CODE-06 / CODE-07 · 其余中低优先级项

| 编号 | 问题 | 修复要点 |
|---|---|---|
| SEC-12 | `/admin/platform/test` 无限流，`port` 任意 | 加每管理员 5 次/60s 限流；`port` 用 `Field(ge=1, le=65535)`；把探测结果写入审计并对连续失败告警 |
| SEC-13 | 注册先建外部账号后建平台账号，平台 commit 失败留孤儿 | 改为「平台账号先落库（status=pending_sync）→ 同步外部 → 标记 active」，或失败时调用补偿删除；引入 outbox 表记录待同步事务 |
| CODE-02 | 审核通过有效期硬编码 30 天 | `admin.py:158` 改为 `datetime.utcnow() + timedelta(days=settings.export_publish_valid_days)` |
| CODE-03 | 宽泛 `except Exception` 吞错 | 分级处理：外部依赖异常降级 + 告警；内部异常向上抛。所有 `logger.warning` 升级为带 `exc_info=True` 的结构化日志 |
| CODE-04 | `DataApplyOut.target_user_id` 与 ORM 漂移 | 用 `mypy` + `pydantic` 双向校验；或给 `DataApply` 补只读 `target_user_id` property 并在 schema 标注 |
| CODE-05 | `_published_dir()` 重复定义 | 抽到 `app/storage.py` 统一提供 `pending_dir(user_id)` / `published_dir(pending_id)` / `generated_dir(user_id)` |
| CODE-06 | `audit_logs.detail` 拼接用户可控内容 | 统一 `_audit(db, action, detail, ...)` 工具函数，内部 `detail = detail[:1000]` 并去除 `\r\n` |
| CODE-07 | 无错误码规范 | 定义 `ErrorCode` 枚举 + `{code, message, detail}` 统一响应体，前端按 `code` 分支 |

---

### PERF-02 / PERF-03 / PERF-04 · 性能项

**PERF-02 · `applies._to_dict` N+1**

```python
# app/routers/applies.py:110-126
rows = (db.query(DataApply)
        .options(joinedload(DataApply.user))     # ← 加这一行，500 次查询降为 1 次
        .order_by(DataApply.created_at.desc(), DataApply.id.desc())
        .offset(skip).limit(limit).all())
```

同时建议把 `(user_id, status)` 的复合索引补上 `created_at`：`CREATE INDEX idx_data_applies_user_status_time ON data_applies(user_id, status, created_at DESC)`。

**PERF-03 · `/results/mine` 无分页**

```python
@router.get("/mine")
def get_my_results(skip: int = Query(0, ge=0), limit: int = Query(50, ge=1, le=200),
                   user=Depends(get_current_user), db=Session=Depends(get_db)):
    ...offset(skip).limit(limit)...
```

**PERF-04 · `analyze_table_columns` 全 Python 扫描**
改为在 SQL 侧做聚合推断（`COUNT(DISTINCT col)`、`MIN/MAX`），或把采样行数降到 500 并只对前 50 列做类型推断；结果按 `(table, total_rows)` 缓存已有，再补一个 TTL。

---

### ARCH-01 ~ ARCH-05 · 架构项

| 编号 | 问题 | 修复方向 |
|---|---|---|
| ARCH-01 | 启动 `create_all` + 手写 DDL，无 Alembic；多 worker 竞争 | 引入 Alembic；迁移用 `SELECT pg_advisory_lock` 串行化；`create_all` 从应用启动移到独立 `migrate` 命令 |
| ARCH-02 | 启动即同步演示账号到 Windows/Guacamole | 移到 `python -m app.cli sync-demo`；应用启动不再产生外部副作用 |
| ARCH-03 | 无监控/告警/结构化日志 | 见第五节「补充建议」 |
| ARCH-04 | SQLite 下 `with_for_update()` 空操作 | 生产强制 PostgreSQL（启动时校验 `database_url` 不以 `sqlite` 开头且 `APP_ENV=prod` 时报错） |
| ARCH-05 | `schema.sql` 与 ORM 漂移（scopes/user_scope/dept_id） | 用 `alembic autogenerate` 反向生成 DDL，或加一条 CI 检查对比 ORM 与 DDL |

---

## 四、优化路线图

### 立即修复（本周内，P0 + 关键 P1）

1. **SEC-01** 清理 `.env` 废弃键 + 加 `.env.example` 契约测试 → 恢复启动与 CI
2. **LOG-01** 删除 `DataApply(target_user_id=...)` + 前端传 `null` → 恢复管理员直接下发
3. **SEC-02** 免审规模闸门 + 全量读取 + 分片配额 + `EXPORT_AUTO_PUBLISH_ENABLED`
4. **SEC-03** 基线同源校验 + 免审总开关 + 基线自检接口
5. **SEC-06** Windows 投递路径白名单与黑名单（含 `upload_file_to_windows` 二次校验）
6. **LOG-02** `reject_pending` 行锁 + 条件更新认领
7. **LOG-03** `generating` 不可驳回 + 后台任务条件更新写回

### 短期优化（2~4 周，P1/P2）

8. **SEC-04** XFF 可信代理解析（后端 + nginx `real_ip`）
9. **SEC-05/PERF-01** 导出接口限流 + 文件数量/体积上限 + SSH 连接复用
10. **SEC-07** 安全头覆盖 SPA 首页 + 补 `X-Frame-Options`
11. **SEC-08** SSH known_hosts + RejectPolicy
12. **SEC-09** 账号停用接口（含外部联动）
13. **SEC-11** README 资产脱敏 + 生产演示密码强度校验
14. **PERF-02/03/04** joinedload、分页、列分析 SQL 化
15. **CODE-01** 补齐关键路径测试（见第五节）
16. **SEC-12** 平台测试连接限流与端口范围校验

### 中期重构（1~2 月）

17. **ARCH-01** 引入 Alembic，移除启动期 DDL
18. **ARCH-02** 启动副作用外移到 CLI
19. **SEC-10** JWT `jti` + 黑名单 + refresh token
20. **SEC-13** 外部同步事务化（outbox + 补偿）
21. **PERF-05** 后台任务从 ThreadPool 迁到 RQ/Celery（跨进程、可重试、可观测）+ stale generating 定时补偿
22. **PERF-06** 统一外部调用超时/重试/熔断（tenacity）
23. **CODE-07** 统一错误码与响应体规范

### 长期治理（季度级）

24. **ARCH-03** 指标体系 + 告警 + 结构化日志 + 链路追踪
25. 前后端类型契约自动化（OpenAPI → TS 代码生成，消除 CODE-04 类漂移）
26. 导出策略引擎化：把「扩展名门禁 / 相似度 / 规模闸门 / 配额」抽象为可配置规则链，支持不同数据密级
27. 引入 SAST（bandit / semgrep）+ 依赖漏洞扫描到 CI，形成自动化审计
28. 定期演练：导出绕过红队测试、SSH 中断补偿演练、账号生命周期演练

---

## 五、补充建议

### 5.1 需要补充的监控指标

| 指标 | 类型 | 告警阈值建议 |
|---|---|---|
| `http_requests_total{route,status}` | Counter | 5xx 比率 > 1% 持续 5min |
| `http_request_duration_seconds{route}` | Histogram | P95 > 3s |
| `auth_login_failed_total` | Counter | 单 IP 5min 内 > 20 |
| `export_request_total{decision}` | Counter | `decision=auto` 占比突增 |
| `export_auto_published_bytes_total` | Counter | 单日 > 基线 3 倍 |
| `sftp_connection_failures_total` | Counter | 连续 3 次失败 |
| `generate_job_duration_seconds` | Histogram | P95 > 300s |
| `generate_job_failed_total` | Counter | 任意失败立即告警 |
| `jobs_inflight` | Gauge | 持续 = max_workers 超过 10min |
| `pending_files_unreviewed` | Gauge | > 50 条提醒管理员 |
| `export_results_expired_uncleaned` | Gauge | > 1000 |

### 5.2 需要补充的日志

- **结构化日志**：把 `logging` 配置成 JSON（含 `ts/level/logger/trace_id/user_id/route`），便于采集。
- **请求级 `trace_id`**：中间件生成并透传到响应头 `X-Trace-Id`，审计日志增加 `trace_id` 列，实现「审计 → 应用日志 → Windows 操作」三段串联。
- **必须补记的事件**：
  - `logout`（当前完全无记录）
  - `session_connect_failed`（当前只在成功时写）
  - `export_request` 的**每个文件**判定明细（当前只汇总写一条）
  - `platform_config_read`（敏感配置被读取应留痕）
  - `data_generate` 的 `filters`（当前只记了 filter 数量，无法还原下发了什么）→ **这是审计盲区，建议记录归一化后的 filters 并脱敏**
  - `user_disabled` / `role_change`
- **日志脱敏**：统一 `_audit()` 工具函数，禁止把密码、token、完整路径直接写 detail。

### 5.3 需要补充的单元测试（关键路径）

| 用例 | 目标 |
|---|---|
| `test_generate_without_apply_id` | LOG-01 回归 |
| `test_generate_concurrent_double_submit` | 重复提交 409 |
| `test_reject_approve_race` | LOG-02 回归 |
| `test_reject_while_generating` | LOG-03 回归 |
| `test_generate_abandoned_when_rejected` | LOG-03 回归 |
| `test_export_bypass_padding_2mb` | SEC-02 回归（2MB 填充） |
| `test_export_bypass_chunked_files` | SEC-02 回归（分片） |
| `test_export_normal_stats_file_autopublished` | 防误伤 |
| `test_client_ip_spoof_protection` | SEC-04 回归 |
| `test_export_rate_limit` | SEC-05 回归 |
| `test_platform_config_path_blacklist` | SEC-06 回归 |
| `test_security_headers_on_spa_index` | SEC-07 回归 |
| `test_demo_password_policy_in_prod` | SEC-11 回归 |
| `test_env_example_contract` | SEC-01 回归 |
| `test_data_applies_no_n_plus_one` | PERF-02（用 `assert query_count < N`） |

同时建议：把 `tests/` 纳入 CI 强制门禁（当前 SEC-01 说明它根本没在跑）。

### 5.4 需要补充的接口校验

| 接口 | 缺失校验 | 建议 |
|---|---|---|
| `/data/generate` | `filters` 无键数量/值长度上限；`filename` 已做清洗但无长度上限（DB 列 256） | `filename` ≤ 200 字符；`filters` ≤ 50 键，IN 列表 ≤ 100 值 |
| `/data/generate` | 无 `target_user_id` 与 `apply_id` 一致性以外的越权校验（admin 可给任意用户下发全量） | 增加「全量下发（filters 为空）」二次确认参数 `confirm_full_export: bool` |
| `/admin/pending/{id}/approve|reject` | `reason` 无长度上限 | `max_length=500` |
| `/user/data-applies` | `purpose` 无长度上限、无 HTML 转义 | `max_length=1000`；响应时前端用文本插值 |
| `/admin/platform-config` | `port` 无范围；`workspace_dir/output_path` 无校验（SEC-06） | `ge=1, le=65535` + 路径白名单 |
| `/admin/platform/test` | `host`/`port` 无频率控制 | 限流 + 审计 |
| 全局 | 无请求体大小限制（`client_max_body_size 50m` 仅在 nginx） | 加 `RequestBodyLimitMiddleware` 或路由级校验 |

### 5.5 需要补充的权限校验

| 位置 | 现状 | 建议 |
|---|---|---|
| `PUT /admin/platform-config` | 任意 `admin` 可改投递路径（SEC-06） | 路径白名单；敏感项变更要求 `superadmin` |
| 导出审批 | `admin` 可审批任何人的申请，包括自己的 | 禁止审批自己的申请（`pf.user_id == admin.id` → 403） |
| 数据下发 | `admin` 可给任意用户（含自己）下发全量 | 全量下发强制二次确认 + 独立审计动作 `data_generate_full` |
| 角色管理 | 已有「不能改自己 / 不能动 superadmin」 | 建议追加：不允许把自己以外的最后一个 superadmin 降级 |
| 审计日志查询 | `admin` 可看全部 | 建议对 `cli_role_change` 等超管动作仅 superadmin 可见 |
| 消息中心 | 已按 `user_id` 过滤 | OK，建议 `/messages/{id}/read` 的 404 与 403 统一（当前 404，信息泄露面很小，可接受） |

---

## 六、第二轮补充审计（环境事实确认后）

> 本章基于你补充的三条事实重新推导。**新增 5 项发现（SEC-14 ~ SEC-16、PERF-07、ARCH-06），修订 3 项原有判定。**

### 6.0 本轮确认的环境事实

| 项 | 结论 | 对审计的影响 |
|---|---|---|
| 部署形态 | **单 uvicorn worker，无多进程** | SPOF；内存态组件（限流/inflight）无失效问题，但也没有冗余 |
| 数据库 | **PostgreSQL**（非 SQLite） | `SELECT ... FOR UPDATE` 行锁**真实生效** → LOG-02/03 修复方案确认可落地 |
| 缓存 | **无 Redis** | 限流只能内存实现 → 引出 SEC-16；水平扩展受阻 |
| 数据同源性 | `testData.csv` 与 `test_data` 宽表**同源**（开发测试数据） | SEC-03 参照系成立；但引出新的基线漂移风险 SEC-14 |
| Windows 脚本 | `login.ps1` 与仓库同步；`enforce-output-location.ps1` **最近一次装软件后未重跑** | 引出 SEC-15 |

### 6.1 原判定修订

| 编号 | 原判定 | 修订后 | 修订依据 |
|---|---|---|---|
| **PERF-05** | P2「同步阻塞调用阻塞事件循环」 | **降为 P3** | 实测：全部路由均为同步 `def`（`admin.py` 中 `async def` 数量为 **0**），FastAPI/Starlette 会将其丢进 anyio 线程池执行，paramiko 的 SSH 阻塞**不会**卡住事件循环。剩余风险仅为线程池 40 条线程上限，不是事件循环阻塞。 |
| **ARCH-01** | P2「多 worker 并发启动迁移竞争」 | **降为 P3**（竞争部分） | 单 worker 下不存在并发 `create_all` 竞争。但「`schema.sql` 与 ORM 双轨、无版本化迁移」的问题依旧保留，且 PostgreSQL 上手写 `ALTER TABLE` 无事务保护，风险仍在。 |
| **LOG-02 / LOG-03** | P1「并发导致状态不一致，建议 `with_for_update()`」 | **维持 P1，且方案已确认可行** | PostgreSQL 下行锁真实生效（SQLite 下 `with_for_update()` 是空操作，原报告对此留了不确定性）。现在可以放心按原方案落地。 |

### 6.2 新增问题清单

| 编号 | 模块 | 问题描述 | 风险等级 | 影响范围 | 修复优先级 |
|---|---|---|---|---|---|
| **SEC-14** | `review.py` / `dataset.py` | 相似度基线是**静态文件** `testData.csv`，而生产真实数据在 PostgreSQL `test_data` 宽表；二者仅在"开发时同源"，运行时无同步校验。宽表更新后基线滞后 → 拷贝新明细行导出，相似度低 → **免审自动发布** | **P1** | 核心资产（原始数据）外泄 | 立即 |
| **SEC-15** | `powershell/` | `software-registry.json` 为**空数组 `[]`** → 无任何软件快捷方式（`WorkingDirectory=W:` 的强制入口不存在）；叠加 `login.ps1` 已把桌面/文档/下载**改回本地 profile**，新装软件的生成物落在 `C:\Users\<用户名>\`，脱离 W:/pending 管控与后端 ACL | **P1** | 数据滞留在平台管控外、无审计 | 立即 |
| **SEC-16** | `rate_limit.py` | 限流器 `_hits` 只在**同 key 再次被访问时**清理，未活跃 key 永不回收 → 结合 SEC-04（XFF 可伪造）攻击者可灌入任意数量 key → **内存无界增长 → 单 worker OOM → 全站不可用** | **P1** | 全站可用性（SPOF 放大） | 立即 |
| **PERF-07** | `database.py` | 连接池 `pool_size=20` + 默认 `max_overflow=10` = 上限 30，**小于** FastAPI 线程池 40；且未设 `pool_timeout` / `pool_recycle`，并发时请求排队至默认 30s 后才 500 | **P2** | 并发下的响应时延与 500 | 短期 |
| **ARCH-06** | 部署 | 单 worker 无进程守护（未见 systemd/supervisor 配置）；无 Redis 使限流、`_inflight`、缓存均为进程本地态，横向扩容即失效 | **P2** | 可用性 / 扩展性 | 短期 |

---

### SEC-14 · 相似度基线是静态文件，与生产库无同步校验 → 免审判定可被"数据更新"绕过 【P1 · 安全】

**1. 问题位置**
- `app/review.py:421` — `base = _load_baseline(baseline_path or _settings.dataset_csv_path)`
- `app/config.py` — `dataset_csv_path: str = "testData.csv"`
- `app/dataset.py:103` `generate_excel_from_table()` — 生产下发走的是 PostgreSQL 业务宽表 `test_data`
- `app/review.py:312-342` `_load_baseline()` — 缓存键为 `(mtime_ns, size)`，**只检测文件本身有没有变，不检测库有没有变**

**2. 问题类型**：安全（逻辑缺陷 → 核心数据外泄）

**3. 风险等级**：**P1**

**4. 触发条件 / 复现路径**

你已确认 `testData.csv` 与 `test_data` 宽表同源 —— 这证明**比对机制本身设计正确**，但"同源"是一次性的事实，不是持续保证：

1. 运维向 `test_data` 宽表导入新一批数据（新增行 / 新增列 / 修正字段），**未重新导出** `testData.csv`；
2. 用户把**新批次**的明细行原样拷进 `result.csv` 提交导出；
3. `_load_baseline` 读到旧 `testData.csv`：这些新行不在 `line_set` 中 → `line_ratio ≈ 0`；新行的 token 与旧基线重叠有限 → `token_ratio` 低；
4. `score < 阈值 60%` → `decide_export_review` 返回 `"auto"` → **免审自动发布**。

关键点：宽表**越大、越新**，基线滞后越严重，绕过越容易。极端情况下若基线文件缺失，`_load_baseline` 返回 `None` → 已安全兜底转人工（这点设计是对的），但"文件存在但内容过期"**没有任何检测**。

**5. 影响说明**
免审自动发布是平台唯一的"无人值守出口"。基线一旦滞后，该出口等于对用户敞开，管理员全程无感知，审计日志只有一条 `export_auto_approved`，无法事后追溯哪些数据被带出。

**6. 修复建议**

两层措施，缺一不可：

- **① 基线必须由生产库生成，不允许手工维护**：新增 `refresh_baseline` 命令，从 `test_data` 全量导出为基线 CSV，同时写入 `.meta.json`（行数、列数、内容 SHA256、生成时间、源库快照时间）。
- **② 比对前校验新鲜度与一致性**：基线超过 `BASELINE_MAX_AGE_HOURS`（建议 24h）或行数/哈希与库当前状态不符 → `_load_baseline` 返回 `None` → **安全默认转人工**（复用已有的 None 分支）。
- **③ 启动自检**：应用启动时校验基线可用性，不可用则告警并强制所有导出走人工。

**7. 修复代码**

```python
# ---- 新增 app/baseline.py ----
import hashlib, json, os, time
from sqlalchemy import text

BASELINE_META_SUFFIX = ".meta.json"
BASELINE_MAX_AGE_HOURS = 24   # 可走配置：settings.baseline_max_age_hours


def refresh_baseline(db, out_path: str, table: str = "test_data") -> dict:
    """从生产业务宽表全量重建相似度基线，并写入元信息。

    必须由导入/更新数据的流程显式调用，或由定时任务每日执行。
    """
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    rows = db.execute(text(f"SELECT * FROM {table}")).fetchall()
    cols = list(db.execute(text(f"SELECT * FROM {table} LIMIT 0")).keys())

    h = hashlib.sha256()
    n = 0
    with open(out_path, "w", encoding="gbk", newline="") as f:
        f.write(",".join(cols) + "\n")
        h.update((",".join(cols) + "\n").encode("gbk", errors="replace"))
        for r in rows:
            line = ",".join("" if v is None else str(v) for v in r)
            f.write(line + "\n")
            h.update((line + "\n").encode("gbk", errors="replace"))
            n += 1

    meta = {
        "table": table,
        "row_count": n,
        "col_count": len(cols),
        "content_sha256": h.hexdigest(),
        "generated_at": int(time.time()),
    }
    with open(out_path + BASELINE_META_SUFFIX, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    return meta


def baseline_is_fresh(path: str, db=None, table: str = "test_data") -> tuple[bool, str]:
    """基线是否可用：存在 + 未过期 + 行数与库一致。任一项不满足即不可用。"""
    meta_path = path + BASELINE_META_SUFFIX
    if not os.path.exists(path):
        return False, "基线文件不存在"
    if not os.path.exists(meta_path):
        return False, "基线缺少 meta（可能为手工维护的旧文件）"

    meta = json.load(open(meta_path, encoding="utf-8"))
    age_h = (time.time() - meta["generated_at"]) / 3600
    if age_h > BASELINE_MAX_AGE_HOURS:
        return False, f"基线已过期（{age_h:.1f}h > {BASELINE_MAX_AGE_HOURS}h）"

    if db is not None:
        cur = db.execute(text(f"SELECT COUNT(*) FROM {table}")).scalar()
        if cur != meta["row_count"]:
            return False, f"基线与库行数不一致（基线 {meta['row_count']} vs 库 {cur}），疑似数据已更新"
    return True, "ok"
```

```python
# ---- app/review.py 修改 _load_baseline ----
def _load_baseline(baseline_path: str, db=None):
    """加载基线；新鲜度/一致性校验失败时返回 None（调用方安全默认转人工，SEC-14）。"""
    ok, why = baseline_is_fresh(baseline_path, db=db)
    if not ok:
        logger.warning("相似度基线不可用，导出将转人工审核：%s", why)
        return None
    # ↓ 以下为原有按 mtime 缓存逻辑，保持不变
    ...
```

```python
# ---- app/main.py 启动自检追加 ----
from app.baseline import baseline_is_fresh
_ok, _why = baseline_is_fresh(settings.dataset_csv_path)
if not _ok:
    logger.error("相似度基线不可用，免审通道存在绕过风险：%s", _why)   # 接入告警
```

**8. 回归验证**
- 用例 A：向 `test_data` 插入 1000 行后**不** `refresh_baseline` → 提交一份拷贝这些新行的 CSV → 断言 `decide_export_review` 返回 `review`（修复前返回 `auto`）。
- 用例 B：`refresh_baseline` 后立即提交同样文件 → 断言返回 `review`（相似度 ≥ 阈值）。
- 用例 C：删除 `.meta.json` → 断言返回 `review`。
- 用例 D：断言基线不可用时 `AuditLog` 有告警动作记录。

---

### SEC-15 · 软件注册表为空 + shell 文件夹已归位本地 → 新装软件生成物脱离平台管控 【P1 · 安全 / 运维】

**1. 问题位置**
- `powershell/software-registry.json` — 当前内容为 **`[]`**（空数组）
- `powershell/login.ps1:185-212` — 快捷方式完全由注册表驱动；`else` 分支仅 `Write-Warning "未找到软件注册表"`，**空数组不会触发该告警**（文件存在，只是没条目）
- `powershell/login.ps1:202-212` — `$shortcut.WorkingDirectory = $WDrive`（`W:`）是唯一的"启动目录强制"入口，注册表为空 ⇒ 该入口**根本不生成**
- `powershell/login.ps1:101-139` — 桌面/文档/下载**已改回本地默认** `C:\Users\<用户名>\`（需求变更），不再重定向到 `W:`
- `powershell/login.ps1:227-240` — 只有 `\\127.0.0.1\pending\<用户名>` 有快捷方式且被 `icacls` 锁定

**2. 问题类型**：安全（管控边界失效）+ 运维（流程断裂）

**3. 风险等级**：**P1**

**4. 触发条件**

对"最后一次安装的软件"逐条核对强制链：

| 强制措施 | 状态 | 说明 |
|---|---|---|
| 快捷方式 `WorkingDirectory = W:` | ❌ **失效** | `software-registry.json` 为空，无任何软件快捷方式被创建 |
| 桌面/文档/下载重定向到 W: | ❌ **已取消** | `login.ps1:103` 明确"需求变更：W: 仅作数据工作区，不再承接桌面/文档/下载" |
| HKLM `PlacesBar`（W:/Z:） | ⚠️ **取决于历史** | `enforce-output-location.ps1` 是机器级幂等配置，**若此前运行过，对新装软件同样生效**（脚本注释已说明）→ 未重跑本身不是根因 |
| 隐藏 C: 盘（`NoDrives=4`） | ✅ 生效 | 仅资源管理器隐藏，不等于禁止写入 |
| `-HardenRootAcl`（禁止在 C:\ 根建目录） | ❓ **未知** | 需确认是否执行过；默认跳过 |

结论：用户启动新装软件后"另存为"，默认位置是**桌面/文档/下载 = `C:\Users\<用户名>\`**（RDS 主机本地盘）。

**5. 影响说明**

- **管控外滞留**：`C:\Users\<用户名>` 不在后端 `icacls` 锁定范围（后端只锁 `C:\workspace\<用户名>` 与 `C:\pending\<用户名>`），不进平台审计，平台侧完全不可见。
- **管理员豁免放大**：`login.ps1` 的隐藏 C: 盘、shell 重定向等措施对管理员自动豁免。管理员在同一台 RDS 主机登录时可直接访问这些本地文件 → 绕开"唯一出口"审计。
- **流程断裂（次要）**：结果落在桌面后无法申请导出，用户需手动复制到 `待导出目录`，体验与合规培训成本上升。
- **缓解事实（重要，避免误判为 P0）**：导出出口仍然唯一 —— 后端只接受 `pending` 目录的文件，所以这**不是"直接外泄"，而是"数据在管控区外长期滞留"**。因此定 P1 而非 P0。

**6. 修复建议**（按见效速度排序，均为非破坏性）

1. **补齐 `software-registry.json`** —— 一条命令的事，立即恢复 `WorkingDirectory = W:`：
   ```json
   [
     { "key": "spss", "name": "SPSS", "path": "C:\\Program Files\\IBM\\SPSS\\Statistics\\29\\stats.exe", "args": "" },
     { "key": "sas",  "name": "SAS",  "path": "C:\\Program Files\\SASHome\\SASFoundation\\9.4\\sas.exe", "args": "" }
   ]
   ```
   复制到 `C:\stats-scripts\` 后用户重新登录即生效。
2. **跑一次 `enforce-output-location.ps1`** 确认 HKLM `PlacesBar` 存在（幂等，安全）。确认项：
   ```powershell
   Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\ComDlg32\PlacesBar"
   ```
   若已存在 `Place0=W:\`、`Place1=Z:\` 说明机器级约束在位，不必重跑。
3. **明确 `-HardenRootAcl` 决策**：若确定没有软件需要写 `C:\` 根，建议执行（可先在测试机验证）。
4. **给"空注册表"加显式告警**（改 `login.ps1`，避免静默失效）：
   ```powershell
   if ($SoftwareConfigs.Count -eq 0) {
       Write-Warning "软件注册表为空或未配置有效条目：本次不会生成任何软件快捷方式，" +
                     "软件启动目录不受控，生成物可能落在本机 profile。请检查 software-registry.json。"
   }
   ```
5. **（可选，纵深）**对 `C:\Users\*\Desktop|Documents|Downloads` 下的 `.csv/.xlsx/.dta/.sav/.rds` 做周期性扫描告警，把"管控外滞留"变成可观测事件。

**7. 回归验证**
- 以普通用户登录 → 断言桌面出现新软件快捷方式 → 右键属性「起始位置」应为 `W:\`。
- 在新软件中执行"另存为" → 断言默认路径落在 `W:\` 而非 `C:\Users\<用户名>\`。
- 断言 `software-registry.json` 为空时登录日志出现上述 Warning。

---

### SEC-16 · 限流器内存无界增长 + XFF 可伪造 + 单 worker ⇒ 一次打挂全站 【P1 · 安全 / 可用性】

**1. 问题位置**
- `app/rate_limit.py:24-27` — `_cleanup(key, window)` 只清理**当前这一个 key** 的过期记录
- `app/rate_limit.py:34-43` — `_cleanup` 仅在 `check(key)` 内被调用，即**只有该 key 再次被访问时才可能回收**
- `app/rate_limit.py:22` — `self._hits: dict[str, list[float]] = defaultdict(list)`，**无 key 数量上限**
- `app/rate_limit.py:50-56` — `get_client_ip` 信任伪造的 XFF（即 SEC-04）
- 环境：单 uvicorn worker、无 Redis

**2. 问题类型**：安全（资源耗尽 DoS）+ 架构（SPOF 放大）

**3. 风险等级**：**P1**

**4. 触发条件 / 复现**

1. 攻击者对每个请求带上**不同的** `X-Forwarded-For`（SEC-04 已确认可伪造，nginx 用 `$proxy_add_x_forwarded_for` 是追加，代码取 `split(",")[0]` 拿到伪造值）；
2. 每个伪造 IP 命中一次 `/auth/login`，`_limiter.check(f"login:{ip}", 5, 60)` 写入一条记录并返回放行；
3. 该 key 此后**再也不会被访问** → `_cleanup` 永不对其执行 → 这条 `list` 与字符串 key **永久驻留内存**；
4. 重复 N 次 → 内存增长约 `N × (key 字符串 + list 对象 + float) ≈ N × 150~250 字节`。百万级请求即可吃掉数百 MB；
5. **单 worker 无冗余** → 进程 OOM 或被 OOM-killer 杀掉 → **全站不可用**，且无进程守护时不会自动恢复。

这条链的严重性由"单 worker + 无 Redis"这个环境事实**从 P2 放大到 P1**：同样的漏洞在多 worker + 有守护的部署下只是内存偏高，在这里等于一键打挂。

**5. 影响说明**
- 无需认证、无需有效凭据的低门槛 DoS；
- 影响全站（登录、导出、审批全部中断）；
- 限流本该是防护组件，反而成为攻击放大器。

**6. 修复建议**

按"先堵源头、再加兜底"两步：

- **① 堵源头（SEC-04）**：IP 不可由客户端伪造。nginx 侧改为覆盖而非追加（最省事且彻底）：
  ```nginx
  proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖，丢弃客户端自带值
  ```
  或后端按可信代理层数从右往左取（原报告 SEC-04 已给代码）。IP 收敛为真实客户端后，key 空间自然受限。
- **② 加兜底**：全局定期清扫 + key 数量上限，即使 IP 仍可伪造也不会无界增长。

**7. 修复代码**

```python
# ---- app/rate_limit.py 改造 ----
class SlidingWindowRateLimiter:
    def __init__(self, max_keys: int = 50_000, sweep_interval: float = 60.0):
        self._lock = threading.Lock()
        self._hits: dict[str, list[float]] = defaultdict(list)
        self._max_keys = max_keys
        self._sweep_interval = sweep_interval
        self._last_sweep = time.monotonic()
        self._max_window = 300.0   # 当前所有窗口的最大值，清扫时统一用它做 cutoff

    def _sweep(self, now: float) -> None:
        """全局清扫：移除所有窗口外的记录与空 key（SEC-16）。"""
        cutoff = now - self._max_window
        for k in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
            del self._hits[k]
        self._last_sweep = now

    def check(self, key: str, max_attempts: int, window_seconds: int) -> Tuple[bool, int]:
        with self._lock:
            now = time.monotonic()
            # ① 周期性全局清扫（无论哪个 key 被访问都触发）
            if now - self._last_sweep > self._sweep_interval:
                self._sweep(now)

            self._cleanup(key, window_seconds)
            hits = self._hits[key]

            # ② key 数量硬上限：超限先清扫一次，仍超限则拒绝新 key
            if len(hits) == 0 and len(self._hits) >= self._max_keys:
                self._sweep(now)
                if len(self._hits) >= self._max_keys:
                    logger.warning("限流器 key 数达到上限 %s，拒绝新 key（疑似伪造 IP 灌入）", self._max_keys)
                    return False, 60

            if len(hits) < max_attempts:
                hits.append(now)
                return True, 0
            oldest = hits[0]
            wait = int(window_seconds - (now - oldest)) + 1
            return False, max(wait, 1)
```

> 注意：新增窗口参数时需同步更新 `self._max_window`，或在 `check` 中用 `max(self._max_window, window_seconds)` 自适应。拒绝新 key 属 fail-closed，若担心误伤可改为 fail-open + 告警；但配合 ① 修好 SEC-04 后，`max_keys=50000` 对真实 IP 而言不可能触达，建议保持 fail-closed。

**8. 回归验证**
- 用例：模拟 10 万个不同 XFF 各请求一次 `/auth/login` → 等待 2 个清扫周期 → 断言 `len(_limiter._hits)` 回落至接近 0（修复前恒为 10 万）。
- 用例：将 `max_keys` 临时设为 10 → 第 11 个新 IP 应被拒（429）并产生 warning 日志。
- 压测：断言限流器内存占用在 30 分钟恒定流量下不单调增长。

---

### PERF-07 · 连接池上限（30）小于线程池（40），且无超时/回收配置 【P2 · 性能】

**1. 问题位置**：`app/database.py:10`
```python
engine = create_engine(settings.database_url, pool_pre_ping=True, pool_size=20)
```
`max_overflow` 未指定 → 取 SQLAlchemy 默认 **10**，故硬上限 = **30** 连接。

**2. 问题类型**：性能 / 稳定性

**3. 风险等级**：**P2**（单 worker、低并发下不易触发；并发上来后是硬瓶颈）

**4. 触发条件**
- 全部路由为同步 `def` → anyio 线程池默认 **40** 条线程，最多 40 个请求并发执行；
- 其中超过 30 个请求同时需要 DB 会话 → 多出的线程在 `pool_timeout`（默认 **30s**）上排队；
- 排队 30s 后抛 `TimeoutError: QueuePool limit of size 20 overflow 10 reached` → 500。
- 另：`pool_recycle` 未设 → PostgreSQL/中间设备（如 pgbouncer、云厂商 LB）断掉空闲连接后，`pool_pre_ping` 虽能补救但每次都要额外往返。

**5. 影响说明**
并发超过 30 时出现**无预警的 30 秒挂起后批量 500**，用户体感是"系统卡死"，且 PostgreSQL 侧连接数随部署实例数线性增长，需与 `max_connections` 对齐。

**6. 修复建议**
显式声明全部池参数，并让"线程池 ≤ 连接池"成为硬约束：

```python
# app/database.py
engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=20,
    max_overflow=10,      # 显式声明，别依赖默认值
    pool_timeout=10,      # 快速失败，别让用户等 30s
    pool_recycle=1800,    # 30 分钟回收，规避中间设备静默断连
)
```

同时确认 PostgreSQL 侧：`max_connections ≥ 实例数 × (pool_size + max_overflow) + 运维余量`。

**7. 回归验证**
- 并发 50 个需 DB 的请求 → 断言无请求耗时 > 10s，且失败为明确的 503/429 而非 30s 挂起后 500。
- 断言 `SELECT count(*) FROM pg_stat_activity` 峰值 ≤ 30。

---

### ARCH-06 · 单 worker 无进程守护 + 全进程本地态 ⇒ 可用性单点与扩展天花板 【P2 · 架构】

**1. 问题位置**
- 部署：单 uvicorn worker，仓库内未见 systemd unit / supervisor 配置（`README.md` 仅给出裸 `uvicorn app.main:app --host 0.0.0.0 --port 8000`）
- `app/jobs.py:17` `_inflight: set[int]` — 进程内存态
- `app/rate_limit.py:47` `_limiter` — 进程内存态
- `app/review.py:246` `_baseline_cache` — 进程内存态
- `app/main.py:347` — 开发入口带 `reload=True`

**2. 问题类型**：架构 / 可用性

**3. 风险等级**：**P2**（当前规模可接受，但已锁死扩展路径）

**4. 影响说明**
- **SPOF**：任一未捕获异常、OOM（见 SEC-16）、panic 都会让全站下线，且无守护时不会自动拉起；
- **扩展天花板**：`--workers N` 一加，限流（每 worker 独立计数 → 阈值被放大 N 倍）、`is_inflight`（跨 worker 不可见 → 重复提交防不住）、基线缓存（每 worker 一份）全部失真。这三处都是"看起来能水平扩容，实际一扩就错"的陷阱；
- 后台生成任务（`ThreadPoolExecutor(max_workers=2)`）随进程消亡，重启后残留 `generating` 状态只能靠 `is_inflight` 区分，存在人工清理成本。

**5. 修复建议**（分两步，不要求一步到位）

第一步（不引入新组件，先止血）：
```ini
# /etc/systemd/system/stats-platform.service
[Unit]
Description=Stats Platform API
After=network.target postgresql.service

[Service]
Type=simple
WorkingDirectory=/opt/stats-platform
ExecStart=/opt/stats-platform/.venv/bin/uvicorn app.main:app \
          --host 127.0.0.1 --port 8000 --workers 1 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=3
# 内存硬上限，配合 SEC-16 兜底：超限自动重启而不是被 OOM-killer 随机杀
MemoryMax=1G

[Install]
WantedBy=multi-user.target
```
> `--proxy-headers` + `--forwarded-allow-ips` 让 uvicorn 只信任本机 nginx 的 XFF，是 SEC-04 的后端侧兜底。

第二步（需要扩容时）：引入 Redis，把 `_limiter`、`_inflight`、基线缓存迁移过去；`jobs.py` 的 `submit_generate` 签名保持不变，替换为 RQ/Celery 即可（原设计已预留该扩展点）。

**6. 回归验证**
- `systemctl kill -SIGKILL stats-platform` → 断言 3 秒内自动拉起且服务恢复。
- 断言 `MemoryMax` 生效：`systemd-cgtop` 可见内存上限。
- 扩容预演：`--workers 2` 后压测登录，断言限流阈值**未**被放大（当前预期会放大 → 验证该风险真实存在，作为引入 Redis 的依据）。

---

## 七、需要我补充的材料（第二轮更新）

以下问题现有材料无法确认，给出的是基于代码的推断。若能补充，我可以把结论从"疑似"升级为"确认"：

4. **运维与合规**
   - 是否有等保/行业合规要求（决定审计留存期、密码策略强度、日志脱敏要求）？
   - 现有告警渠道（企业微信/邮件/PagerDuty）？
   - 導出结果的 30 天有效期是业务硬要求还是默认值？过期文件是否有清理流程？

5. **前端**
   - `frontend/dist` 是提交进仓库的构建产物，是否有固定的构建/发布流程？当前 dist 与 `src` 是否同步？
   - 是否有埋点/前端错误监控（Sentry 类）？

6. **已知问题**
   - 你提到"当前已知问题"会在后续提供——请补充，我会与本次发现交叉比对，避免重复或遗漏。

---

### 附：本次审计已实测确认的事实

| 项 | 证据 |
|---|---|
| 应用与测试无法启动 | `pytest -q` 输出 `ValidationError: rstudio_path / mplus_path / stata_path Extra inputs are not permitted` |
| `DataApply(target_user_id=...)` 必抛 TypeError | SQLAlchemy declarative 构造实测：`TypeError: 'target_user_id' is an invalid keyword argument for M` |
| 中间件顺序 | `starlette/applications.py:107` 为 `self.user_middleware.insert(0, ...)`，`:81` 为 `for ... in reversed(middleware)` |
| 演示账号弱密码 | `.env:12-13` = `admin123` / `user123` |
| 相似度只读前 2MB | `app/review.py:242` `_MAX_CANDIDATE_CHARS = 2 * 1024 * 1024`，`:378` `raw = f.read(_MAX_CANDIDATE_CHARS)` |
