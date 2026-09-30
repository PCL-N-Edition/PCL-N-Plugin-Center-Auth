-- Keep website identity and Xbox resource grants separate. Existing tokens are
-- retained but must be renewed using the Xbox-only authorization flow.
ALTER TABLE oauth_states ADD COLUMN purpose TEXT NOT NULL DEFAULT 'identity' CHECK(purpose IN ('identity','minecraft'));
ALTER TABLE oauth_states ADD COLUMN session_hash TEXT;
ALTER TABLE oauth_states ADD COLUMN session_scope TEXT;
ALTER TABLE oauth_states ADD COLUMN code_verifier TEXT;
ALTER TABLE microsoft_tokens ADD COLUMN grant_version INTEGER NOT NULL DEFAULT 0;
