CREATE TABLE launcher_presence(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  certificate TEXT,
  launcher_last_at INTEGER,
  game_last_at INTEGER,
  launcher_ms INTEGER NOT NULL DEFAULT 0 CHECK(launcher_ms>=0),
  game_ms INTEGER NOT NULL DEFAULT 0 CHECK(game_ms>=0),
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE launcher_activity_days(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  logged_in INTEGER NOT NULL DEFAULT 0 CHECK(logged_in IN (0,1)),
  game_started INTEGER NOT NULL DEFAULT 0 CHECK(game_started IN (0,1)),
  launcher_ms INTEGER NOT NULL DEFAULT 0,
  game_ms INTEGER NOT NULL DEFAULT 0,
  xp_earned INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(user_id,day)
);
-- 保留历史经验；历史奖励占用其北京时间当日额度。
INSERT INTO launcher_activity_days(user_id,day,xp_earned)
SELECT user_id,date(occurred_at,'+8 hours'),sum(amount) FROM xp_events
GROUP BY user_id,date(occurred_at,'+8 hours');
CREATE TABLE launcher_activity_events(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  type TEXT NOT NULL,
  certificate TEXT NOT NULL,
  xp INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  PRIMARY KEY(user_id,id)
);
CREATE INDEX launcher_activity_retention ON launcher_activity_events(occurred_at);
CREATE TABLE badge_verifications(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge_id TEXT NOT NULL CHECK(badge_id IN ('bilibili-level','bilibili-million','donor')),
  verified_value INTEGER NOT NULL CHECK(verified_value>=0),
  source_account TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  PRIMARY KEY(user_id,badge_id)
);
CREATE TABLE user_level_display(
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  badge_id TEXT,
  updated_at TEXT NOT NULL
);
