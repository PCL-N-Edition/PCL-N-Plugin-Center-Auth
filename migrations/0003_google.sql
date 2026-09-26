CREATE TABLE oauth_identities_new(
  provider TEXT NOT NULL CHECK(provider IN ('github','microsoft','google')),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(provider, subject),
  UNIQUE(user_id, provider)
);
INSERT INTO oauth_identities_new(provider,subject,user_id,email,created_at,updated_at) SELECT provider,subject,user_id,email,created_at,updated_at FROM oauth_identities;
DROP TABLE oauth_identities;
ALTER TABLE oauth_identities_new RENAME TO oauth_identities;
CREATE INDEX oauth_identities_user ON oauth_identities(user_id);

CREATE TABLE oauth_states_new(
  state TEXT PRIMARY KEY,
  nonce TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider IN ('github','microsoft','google')),
  return_to TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed IN (0,1)),
  created_at TEXT NOT NULL
);
INSERT INTO oauth_states_new(state,nonce,provider,return_to,user_id,expires,consumed,created_at) SELECT state,nonce,provider,return_to,user_id,expires,consumed,created_at FROM oauth_states;
DROP TABLE oauth_states;
ALTER TABLE oauth_states_new RENAME TO oauth_states;
CREATE INDEX oauth_states_expiry ON oauth_states(expires);
