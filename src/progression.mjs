const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
export const LEVEL_THRESHOLDS = { 2: 2000, 3: 5000, 4: 10000, 5: 20000, 6: 50000, 7: 100000 };
export const XP_REWARDS = { launcherLogin: 20, firstGameStart: 30, gameMinutes: 1, launcherMinutes: 5, dailyCap: 500, timeZone: 'Asia/Shanghai' };
export const ACTIVITY_TYPES = new Set(['launcher.login', 'launcher.heartbeat', 'launcher.logout', 'game.start', 'game.heartbeat', 'game.stop']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const activityDay = timestamp => new Date(timestamp + 8 * 3600000).toISOString().slice(0, 10);
export function computeLevel(xp, launched) {
  if (!launched) return 0;
  let level = 1;
  for (let l = 2; l <= 7; l++) if (xp >= LEVEL_THRESHOLDS[l]) level = l; else break;
  return level;
}
export async function loadLevel(env, userId) {
  const row = await env.DB.prepare('SELECT xp,launched,first_launch_at FROM user_levels WHERE user_id=?').bind(userId).first();
  const xp = row?.xp ?? 0, launched = Boolean(row?.launched), level = computeLevel(xp, launched);
  return {
    level, xp, launched, firstLaunchAt: row?.first_launch_at ?? null,
    next: level === 7 ? null : level === 0
      ? { level: 1, threshold: null, remaining: null, requirement: 'game.start' }
      : { level: level + 1, threshold: LEVEL_THRESHOLDS[level + 1], remaining: Math.max(0, LEVEL_THRESHOLDS[level + 1] - xp), requirement: 'xp' }
  };
}
function streaks(days, now) {
  let best = 0, run = 0, previous = null;
  for (const day of days) {
    const stamp = Date.parse(day + 'T00:00:00Z');
    run = previous !== null && stamp - previous === 86400000 ? run + 1 : 1;
    best = Math.max(best, run); previous = stamp;
  }
  const today = activityDay(now), yesterday = activityDay(now - 86400000);
  return { best, current: days.at(-1) === today || days.at(-1) === yesterday ? run : 0 };
}
export async function loadProgression(env, user, now = Date.now()) {
  const [level, presence, days, verifications, selection, today] = await Promise.all([
    loadLevel(env, user.id),
    env.DB.prepare('SELECT launcher_ms,game_ms FROM launcher_presence WHERE user_id=?').bind(user.id).first(),
    env.DB.prepare('SELECT day FROM launcher_activity_days WHERE user_id=? AND game_started=1 ORDER BY day').bind(user.id).all(),
    env.DB.prepare('SELECT badge_id,verified_value,verified_at FROM badge_verifications WHERE user_id=?').bind(user.id).all(),
    env.DB.prepare('SELECT badge_id FROM user_level_display WHERE user_id=?').bind(user.id).first(),
    env.DB.prepare('SELECT xp_earned FROM launcher_activity_days WHERE user_id=? AND day=?').bind(user.id, activityDay(now)).first()
  ]);
  const streak = streaks(days.results.map(d => d.day), now), gameSeconds = Math.floor((presence?.game_ms ?? 0) / 1000);
  const verified = Object.fromEntries(verifications.results.map(v => [v.badge_id, v]));
  const fact = (id, threshold) => (verified[id]?.verified_value ?? 0) >= threshold;
  const badges = [
    { id: 'infinity', name: 'Lv∞', replacesLevel: true, earned: false, requirement: 'Lv7 · MC 100h · 通过∞答题', progress: `${level.level}/7 · ${(gameSeconds / 3600).toFixed(1)}/100h · 题库未开放`, conditions: { level: level.level >= 7, gameTime: gameSeconds >= 360000, quiz: false, quizAvailable: false } },
    { id: 'administrator', name: 'Lv-1', replacesLevel: true, earned: Boolean(user.staff), requirement: '成为网站管理员', progress: user.staff ? '已达成' : '未达成' },
    { id: 'mc-streak', name: 'LvMC', replacesLevel: true, earned: streak.best >= 100, requirement: '连续100天启动MC', progress: `${Math.min(streak.best, 100)}/100天` },
    { id: 'bilibili-level', name: 'b站来的', replacesLevel: false, earned: fact('bilibili-level', 6), requirement: 'B站达到Lv6', progress: fact('bilibili-level', 6) ? '已核验' : '待管理员核验' },
    { id: 'bilibili-million', name: '小黄标', replacesLevel: false, earned: fact('bilibili-million', 1000000), requirement: 'B站粉丝达到100w+', progress: fact('bilibili-million', 1000000) ? '已核验' : '待管理员核验' },
    { id: 'donor', name: '我喜欢你', replacesLevel: false, earned: fact('donor', 100001), requirement: '向Nexa无偿捐赠累计超过1000元', progress: fact('donor', 100001) ? '已核验' : '待管理员核验' }
  ];
  const selected = badges.find(b => b.id === selection?.badge_id && b.replacesLevel && b.earned);
  return {
    ...level, badges,
    display: selected ? { kind: 'badge', label: selected.name, badgeId: selected.id } : { kind: 'level', label: `Lv${level.level}`, badgeId: null },
    activity: { gameSeconds, launcherSeconds: Math.floor((presence?.launcher_ms ?? 0) / 1000), currentStreak: streak.current, bestStreak: streak.best, todayXp: today?.xp_earned ?? 0 },
    rewards: XP_REWARDS
  };
}
export async function selectLevelDisplay(env, user, input) {
  if (!input || !Object.hasOwn(input, 'badgeId') || Object.keys(input).some(k => k !== 'badgeId')) fail(422, '需要 badgeId（普通等级传 null）');
  if (input.badgeId !== null) {
    const badge = (await loadProgression(env, user)).badges.find(b => b.id === input.badgeId);
    if (!badge?.replacesLevel) fail(422, '该铭牌不能替代等级');
    if (!badge.earned) fail(403, '尚未获得该铭牌');
  }
  await env.DB.prepare(`INSERT INTO user_level_display(user_id,badge_id,updated_at) VALUES(?,?,?)
    ON CONFLICT(user_id) DO UPDATE SET badge_id=excluded.badge_id,updated_at=excluded.updated_at`).bind(user.id, input.badgeId, new Date().toISOString()).run();
  return loadProgression(env, user);
}
export function validateVerification(badgeId, input) {
  if (!['bilibili-level', 'bilibili-million', 'donor'].includes(badgeId)) fail(422, '仅支持审核B站与无偿捐赠铭牌');
  if (!input || Object.keys(input).some(k => !['value', 'sourceAccount', 'evidence'].includes(k))) fail(422, '核验字段无效');
  if (!Number.isSafeInteger(input.value) || input.value < 0 || (badgeId === 'bilibili-level' && input.value > 6)) fail(422, '核验数值无效');
  if (typeof input.sourceAccount !== 'string' || !input.sourceAccount.trim() || input.sourceAccount.length > 120) fail(422, '需要来源账户或捐赠记录编号');
  if (typeof input.evidence !== 'string' || input.evidence.trim().length < 8 || input.evidence.length > 1000) fail(422, '需要8–1000字的核验凭证说明');
  return { value: input.value, sourceAccount: input.sourceAccount.trim(), evidence: input.evidence.trim() };
}
const elapsed = (last, now) => last !== null && now >= last && now - last <= 120000 ? Math.min(90000, now - last) : 0;
const onlineGain = (before, delta, unit) => Math.floor((before + delta) / unit) - Math.floor(before / unit);
const receipt = row => ({ id: row.id, type: row.type, xp: row.xp, occurredAt: row.occurred_at });
export async function readActivity(env, userId, eventId) {
  if (!UUID.test(eventId)) fail(400, '事件ID需要UUID');
  const row = await env.DB.prepare('SELECT id,type,xp,occurred_at FROM launcher_activity_events WHERE user_id=? AND id=?').bind(userId, eventId).first();
  if (!row) fail(404, '事件不存在或已超过30天保留期');
  return receipt(row);
}
// 仅由验证过 mTLS 和当前账户会话的 API 服务调用。客户端不能提交经验或时间。
// presence.version 把同一账户的多设备事件串行化，整个 D1 batch 原子提交。
export async function recordActivity(env, user, certificate, input, now = Date.now()) {
  if (!input || !UUID.test(input.id ?? '') || !ACTIVITY_TYPES.has(input.type) || Object.keys(input).some(k => !['id', 'type'].includes(k))) fail(422, '事件仅允许UUID id和活动type');
  if (!/^[a-f0-9]{64}$/i.test(certificate)) fail(403, '缺少有效的客户端证书');
  const eventId = input.id.toLowerCase(), stamp = new Date(now).toISOString(), day = activityDay(now);
  const replay = async () => {
    const row = await env.DB.prepare('SELECT * FROM launcher_activity_events WHERE user_id=? AND id=?').bind(user.id, eventId).first();
    if (!row) return null;
    if (row.type !== input.type || row.certificate !== certificate) fail(409, '事件ID已用于其他内容');
    return { created: false, event: receipt(row), progression: await loadProgression(env, user, now) };
  };
  const existing = await replay(); if (existing) return existing;
  await env.DB.prepare('INSERT OR IGNORE INTO launcher_presence(user_id,updated_at) VALUES(?,?)').bind(user.id, stamp).run();
  for (let attempt = 0; attempt < 5; attempt++) {
    const [presence, daily] = await Promise.all([
      env.DB.prepare('SELECT * FROM launcher_presence WHERE user_id=?').bind(user.id).first(),
      env.DB.prepare('SELECT * FROM launcher_activity_days WHERE user_id=? AND day=?').bind(user.id, day).first()
    ]);
    if (input.type !== 'launcher.login' && (presence.certificate !== certificate || presence.launcher_last_at === null)) fail(409, '请先上报当前账户的启动器登录');
    if (input.type === 'game.heartbeat' && presence.game_last_at === null) fail(409, '请先上报游戏启动');
    if (presence.launcher_last_at > now || presence.game_last_at > now) fail(409, '活动时间顺序无效');
    const login = input.type === 'launcher.login', start = input.type === 'game.start', logout = input.type === 'launcher.logout';
    const launcherDelta = login ? 0 : elapsed(presence.launcher_last_at, now);
    const gameDelta = ['game.heartbeat', 'game.stop'].includes(input.type) ? elapsed(presence.game_last_at, now) : 0;
    const rawXp = (login && !daily?.logged_in ? XP_REWARDS.launcherLogin : 0)
      + (start && !daily?.game_started ? XP_REWARDS.firstGameStart : 0)
      + onlineGain(presence.launcher_ms, launcherDelta, 300000)
      + onlineGain(presence.game_ms, gameDelta, 60000);
    const gain = Math.min(rawXp, Math.max(0, XP_REWARDS.dailyCap - (daily?.xp_earned ?? 0)));
    const gameLast = login || logout || input.type === 'game.stop' ? null : start || input.type === 'game.heartbeat' ? now : presence.game_last_at;
    const [inserted] = await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO launcher_activity_events(user_id,id,type,certificate,xp,occurred_at)
        SELECT ?,?,?,?,?,? WHERE (SELECT version FROM launcher_presence WHERE user_id=?)=? AND EXISTS(SELECT 1 FROM users WHERE id=? AND disabled=0)`).bind(user.id, eventId, input.type, certificate, gain, stamp, user.id, presence.version, user.id),
      env.DB.prepare(`UPDATE launcher_presence SET certificate=?,launcher_last_at=?,game_last_at=?,launcher_ms=launcher_ms+?,game_ms=game_ms+?,version=version+1,updated_at=?
        WHERE user_id=? AND version=? AND changes()=1`).bind(certificate, logout ? null : now, gameLast, launcherDelta, gameDelta, stamp, user.id, presence.version),
      env.DB.prepare(`INSERT INTO launcher_activity_days(user_id,day,logged_in,game_started,launcher_ms,game_ms,xp_earned)
        SELECT ?,?,?,?,?,?,? WHERE changes()=1
        ON CONFLICT(user_id,day) DO UPDATE SET logged_in=max(logged_in,excluded.logged_in),game_started=max(game_started,excluded.game_started),
          launcher_ms=launcher_ms+excluded.launcher_ms,game_ms=game_ms+excluded.game_ms,xp_earned=xp_earned+excluded.xp_earned`).bind(user.id, day, login ? 1 : 0, start ? 1 : 0, launcherDelta, gameDelta, gain),
      env.DB.prepare(`INSERT INTO user_levels(user_id,xp,launched,first_launch_at,updated_at)
        SELECT ?,?,?,?,? WHERE changes()=1
        ON CONFLICT(user_id) DO UPDATE SET xp=xp+excluded.xp,launched=max(launched,excluded.launched),first_launch_at=COALESCE(first_launch_at,excluded.first_launch_at),updated_at=excluded.updated_at`).bind(user.id, gain, start ? 1 : 0, start ? stamp : null, stamp),
      env.DB.prepare(`INSERT INTO xp_events(user_id,type,amount,dedupe_key,occurred_at,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1 AND ?>0`).bind(user.id, input.type, gain, 'activity:' + eventId, stamp, stamp, gain)
    ]);
    if (inserted.meta.changes) return { created: true, event: { id: eventId, type: input.type, xp: gain, occurredAt: stamp }, progression: await loadProgression(env, user, now) };
    const duplicate = await replay(); if (duplicate) return duplicate;
  }
  fail(409, '活动状态已改变，请重试同一个事件ID');
}
