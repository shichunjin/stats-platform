-- ============================================================
-- 统计软件托管平台 数据库 DDL (PostgreSQL)
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
    id          SERIAL PRIMARY KEY,
    username    VARCHAR(64)  NOT NULL UNIQUE,
    ad_sid      VARCHAR(128),                   -- Active Directory SID
    display_name VARCHAR(128),
    dept_id     INTEGER REFERENCES scopes(id),
    role        VARCHAR(16)  NOT NULL DEFAULT 'user',  -- user | admin
    is_active   BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
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
    file_path   VARCHAR(512) NOT NULL,           -- \\fileserver\pending\{user_id}\xxx.csv
    file_size   BIGINT,
    file_type   VARCHAR(16),                     -- csv | png | out | txt
    status      VARCHAR(16)  NOT NULL DEFAULT 'pending', -- pending|approved|rejected
    review_reason TEXT,                          -- 审查失败原因
    reviewed_at  TIMESTAMPTZ,
    reviewed_by  INTEGER REFERENCES users(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_pending_user ON pending_files(user_id, status);

-- 已发布结果表
CREATE TABLE export_results (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id),
    pending_file_id INTEGER REFERENCES pending_files(id),
    result_name     VARCHAR(256) NOT NULL,
    file_path       VARCHAR(512) NOT NULL,        -- \\fileserver\published\{result_id}\
    file_size       BIGINT,
    download_count  INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_export_user ON export_results(user_id);

-- 审计日志表
CREATE TABLE audit_logs (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id),
    action      VARCHAR(64) NOT NULL,            -- login|launch|review|download|...
    detail      TEXT,
    ip_addr     VARCHAR(64),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_user ON audit_logs(user_id, created_at);
CREATE INDEX idx_audit_action ON audit_logs(action);

-- 初始化管理员
INSERT INTO scopes (scope_code, scope_type, scope_name, data_path)
VALUES ('admin', 'dept', '平台管理', '\\\\fileserver\\data\\admin\\');

INSERT INTO users (username, display_name, dept_id, role)
VALUES ('admin', '平台管理员', 1, 'admin');
