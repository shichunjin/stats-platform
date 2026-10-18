-- ============================================================
-- 统计软件托管平台 数据库 DDL (PostgreSQL)
-- ------------------------------------------------------------
-- 与 app/models.py 当前 ORM 全量对齐（安全修复 B15，2026-10 Phase 2）：
--   users            + password_hash / password_version
--   pending_files    + content_sha + 部分唯一索引 ix_pending_files_active
--   export_results   + expires_at
--   audit_logs       + status
--   新增表            dataset_meta / dataset_rows / data_applies / messages
-- 生产以应用启动时的 create_all + 幂等迁移为准（Alembic 规划于 Phase 4），
-- 本文件供按 README 手工建库与结构审阅使用。
-- ============================================================

-- 部门/项目范围表
CREATE TABLE scopes (
    id          SERIAL PRIMARY KEY,
    scope_code  VARCHAR(64)  NOT NULL UNIQUE,   -- dept_001 / proj_002
    scope_type  VARCHAR(16)  NOT NULL,           -- dept | project
    scope_name  VARCHAR(128) NOT NULL,
    data_path   VARCHAR(256) NOT NULL,           -- \\fileserver\data\{scope_code}\
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 用户表
CREATE TABLE users (
    id               SERIAL PRIMARY KEY,
    username         VARCHAR(64)  NOT NULL UNIQUE,
    ad_sid           VARCHAR(128),                -- Active Directory SID
    display_name     VARCHAR(128),
    dept_id          INTEGER REFERENCES scopes(id),
    role             VARCHAR(16)  NOT NULL DEFAULT 'user',  -- user | admin
    is_active        BOOLEAN      NOT NULL DEFAULT TRUE,
    password_hash    VARCHAR(256),                -- 注册用户密码哈希（演示账号为空）
    password_version INTEGER      DEFAULT 1,      -- 改密递增，用于 JWT 失效（B2）
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- 用户-范围关联表（一个用户可属于多个部门/项目）
CREATE TABLE user_scope (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    scope_id    INTEGER NOT NULL REFERENCES scopes(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, scope_id)
);

-- 远程会话表
CREATE TABLE sessions (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    software        VARCHAR(32)  NOT NULL,      -- rstudio | mplus | stata
    win_session_id  VARCHAR(128),               -- RDS session ID / Guacamole ID
    guac_identifier VARCHAR(128),               -- Guacamole connection identifier
    status          VARCHAR(16)  NOT NULL DEFAULT 'pending', -- pending|active|ended
    launched_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    ended_at        TIMESTAMPTZ
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- 待审查文件表
CREATE TABLE pending_files (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id),
    session_id  INTEGER REFERENCES sessions(id),
    file_name   VARCHAR(256) NOT NULL,
    file_path   VARCHAR(512) NOT NULL,           -- fileserver/pending/{user_id}/xxx.csv
    file_size   BIGINT,
    file_type   VARCHAR(16),                     -- csv | png | out | txt
    content_sha VARCHAR(64),                     -- 申请时内容 SHA256（B9 防审核后篡改）
    status      VARCHAR(16)  NOT NULL DEFAULT 'pending', -- pending|approved|rejected
    review_reason TEXT,                          -- 审查失败原因
    reviewed_at  TIMESTAMPTZ,
    reviewed_by  INTEGER REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pending_user ON pending_files(user_id, status);
-- B9：同一用户同名同内容仅允许一条 pending/approved 申请（并发兜底）；
-- rejected 不占唯一位，允许修正后重提；NULL content_sha 互不相等。
CREATE UNIQUE INDEX ix_pending_files_active
    ON pending_files (user_id, file_name, content_sha)
    WHERE status IN ('pending', 'approved');

-- 已发布结果表
CREATE TABLE export_results (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    pending_file_id INTEGER REFERENCES pending_files(id),
    result_name     VARCHAR(256) NOT NULL,
    file_path       VARCHAR(512) NOT NULL,        -- fileserver/published/{result_id}/
    file_size       BIGINT,
    download_count  INTEGER NOT NULL DEFAULT 0,
    expires_at      TIMESTAMPTZ,                  -- 下载有效期，过期不可下载（null = 永久）
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_export_user ON export_results(user_id);

-- 审计日志表
CREATE TABLE audit_logs (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id),
    action      VARCHAR(64) NOT NULL,            -- login|session_connect|export_*|...
    detail      TEXT,
    ip_addr     VARCHAR(64),
    status      VARCHAR(16) DEFAULT 'success',   -- success | failed
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- 数据集元数据表（导入的原始数据集：列名、行数）
CREATE TABLE dataset_meta (
    id           SERIAL PRIMARY KEY,
    name         VARCHAR(128) NOT NULL UNIQUE,
    column_names JSONB,                           -- 列名列表（保序）
    total_rows   INTEGER DEFAULT 0,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 数据集行表（每行 JSONB 字典存储，键为列名）
CREATE TABLE dataset_rows (
    id         SERIAL PRIMARY KEY,
    dataset_id INTEGER NOT NULL REFERENCES dataset_meta(id),
    row_index  INTEGER NOT NULL,
    data       JSONB                              -- {列名: 值}
);
CREATE INDEX idx_dataset_rows_dataset ON dataset_rows(dataset_id, row_index);

-- 用户数据申请表
CREATE TABLE data_applies (
    id           SERIAL PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id),
    data_name    VARCHAR(128) DEFAULT 'testData',
    purpose      TEXT NOT NULL,
    fields       JSONB,                           -- 所需字段列表
    time_start   TIMESTAMPTZ,                     -- 时间范围起
    time_end     TIMESTAMPTZ,                     -- 时间范围止
    priority     VARCHAR(16) DEFAULT 'medium',    -- low | medium | high
    status       VARCHAR(16) DEFAULT 'pending',   -- pending|processing|completed|rejected
    reject_reason TEXT,
    processed_by INTEGER REFERENCES users(id),
    finished_at  TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_data_applies_user ON data_applies(user_id, status);

-- 站内消息表（管理员处理完成后通知用户）
CREATE TABLE messages (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    title      VARCHAR(256) NOT NULL,
    content    TEXT,
    msg_type   VARCHAR(16) DEFAULT 'info',        -- info | success | warning
    link       VARCHAR(256),                      -- 点击跳转的前端路径
    is_read    BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_messages_user ON messages(user_id, is_read);

-- 初始化管理员
INSERT INTO scopes (scope_code, scope_type, scope_name, data_path)
VALUES ('admin', 'dept', '平台管理', '\\fileserver\data\admin\');

INSERT INTO users (username, display_name, dept_id, role)
VALUES ('admin', '平台管理员', 1, 'admin');
