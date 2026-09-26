ALTER TABLE auth_audit ADD COLUMN detail TEXT;
ALTER TABLE oauth_states ADD COLUMN terms_policy_id TEXT;

CREATE TABLE policy_documents(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('terms','privacy','publisher','refunds')),
  version TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  effective_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1 CHECK(current IN (0,1)),
  UNIQUE(kind, version, locale)
);

CREATE TABLE terms_acceptances(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES policy_documents(id),
  accepted_at TEXT NOT NULL,
  UNIQUE(user_id, policy_id)
);

CREATE TABLE privacy_notice_receipts(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id TEXT NOT NULL REFERENCES policy_documents(id),
  provided_at TEXT NOT NULL,
  UNIQUE(user_id, policy_id)
);

CREATE TABLE account_deletion_requests(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','cancelled','finalized')),
  requested_at TEXT NOT NULL,
  execute_after INTEGER NOT NULL,
  cancelled_at TEXT,
  finalized_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX one_pending_deletion ON account_deletion_requests(user_id) WHERE state='pending';
CREATE INDEX deletion_requests_due ON account_deletion_requests(state, execute_after);

CREATE TABLE deletion_tombstones(
  subject_id TEXT PRIMARY KEY,
  deleted_at TEXT NOT NULL,
  deletion_version INTEGER NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE privacy_requests(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL CHECK(request_type IN ('access','correction','deletion','portability','objection','other')),
  state TEXT NOT NULL DEFAULT 'received' CHECK(state IN ('received','verified','processing','completed','rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO policy_documents(id,kind,version,locale,effective_at,content_hash) VALUES
  ('terms-1.0','terms','1.0','zh-CN','2026-09-26','13665d991a4ca5eba6f82c25a76d81a313c4b6e555ade65da9bea2a2d15f11a1'),
  ('privacy-1.0','privacy','1.0','zh-CN','2026-09-26','a0acdf32c4f651783e93ad54bc86f7244b94fbb93dcdb4ad22e1cf983d0f8009'),
  ('publisher-1.0','publisher','1.0','zh-CN','2026-09-26','0f35d7e2ba59c413f4da1fabddffebb69002d477b6056ef4ada390d078802678'),
  ('refunds-1.0','refunds','1.0','zh-CN','2026-09-26','7af2704ab5c01f3e275500165590e67802cf3776531dd2cf55ebdb0dabab8345');

-- 不可登录的系统保管主体：承接注销账户遗留的组织/资源关系（当前暂无发布者表，预先就位）。
INSERT INTO users(id,name,password_hash,staff,disabled,developer) VALUES('system:ghost','system:ghost','system:principal:not-loginable',0,1,0)
  ON CONFLICT(id) DO NOTHING;
