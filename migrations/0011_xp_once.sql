-- 首次启动由数据库保证只计分一次，包括并发与不同 dedupeKey 的重放。
CREATE UNIQUE INDEX xp_first_launch_once ON xp_events(user_id) WHERE type='game.first_launch';
