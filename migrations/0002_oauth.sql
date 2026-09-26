ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN email TEXT;

CREATE TABLE oauth_identities(
  provider TEXT NOT NULL CHECK(provider IN ('github','microsoft')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, subject),
  UNIQUE(user_id, provider)
);
CREATE INDEX oauth_identities_user ON oauth_identities(user_id);
CREATE INDEX users_email ON users(email);

CREATE TABLE oauth_states(
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('github','microsoft')),
  return_to TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  created_at TEXT NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires);
