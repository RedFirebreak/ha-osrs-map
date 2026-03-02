CREATE SCHEMA IF NOT EXISTS groupironman;

CREATE TABLE IF NOT EXISTS groupironman.groups(
       group_id BIGSERIAL UNIQUE,
       group_name TEXT NOT NULL,
       group_token_hash CHAR(64) NOT NULL,
       PRIMARY KEY (group_name, group_token_hash)
);

-- User management tables for singleton clan/friend group
CREATE TABLE IF NOT EXISTS groupironman.users (
    user_id BIGSERIAL PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS groupironman.sessions (
    session_id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES groupironman.users(user_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS groupironman.audit_log (
    log_id BIGSERIAL PRIMARY KEY,
    user_id BIGINT REFERENCES groupironman.users(user_id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    target_user_id BIGINT REFERENCES groupironman.users(user_id) ON DELETE SET NULL,
    details TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
