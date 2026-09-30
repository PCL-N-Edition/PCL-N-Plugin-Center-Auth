-- 社区/赞助账户关联，独立于可用于登录的 oauth_identities。
CREATE TABLE external_connections(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK(provider IN ('bilibili','afdian')),
  subject TEXT NOT NULL,
  private_subject TEXT,
  display_name TEXT,
  followers INTEGER,
  connected_at TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY(user_id,provider),
  UNIQUE(provider,subject)
);
CREATE TABLE connection_authorizations(
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('bilibili','afdian')),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_hash TEXT NOT NULL,
  expires INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1))
);
CREATE INDEX connection_authorizations_expiry ON connection_authorizations(expires);
