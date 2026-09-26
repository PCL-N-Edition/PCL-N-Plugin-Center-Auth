CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, staff INTEGER NOT NULL DEFAULT 0 CHECK(staff IN (0,1)), disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)));
CREATE TABLE sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL CHECK(scope IN ('console','operations')), expires INTEGER NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE TABLE auth_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
