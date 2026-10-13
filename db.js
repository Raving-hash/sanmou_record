const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
fs.mkdirSync(path.join(__dirname, 'uploads'), { recursive: true });

const db = new Database(path.join(__dirname, 'data/app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

// ---------- 配置 / 邀请码 ----------
db.getSetting = (k) => db.prepare(`SELECT value FROM settings WHERE key=?`).get(k)?.value ?? null;
db.setSetting = (k, v) => db.prepare(
  `INSERT INTO settings (key, value) VALUES (?, ?)
   ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);

// 8 位邀请码，去掉了容易看错的 0/O、1/I/L
const ALPHA = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
db.genInviteCode = () => {
  let s = '';
  for (const b of crypto.randomBytes(8)) s += ALPHA[b % ALPHA.length];
  db.setSetting('invite_code', s);
  return s;
};
db.normalizeCode = (c) => String(c || '').toUpperCase().replace(/[\s-]/g, '');

// ---------- 用户 ----------
db.getUserById = (id) => db.prepare(`SELECT * FROM users WHERE id=?`).get(id);
db.getUserByUid = (uid) => db.prepare(`SELECT * FROM users WHERE user_id=?`).get(String(uid).toLowerCase());
db.listUsers = () => db.prepare(`SELECT * FROM users ORDER BY id`).all();
db.createUser = ({ userId, nickname, passwordHash, isAdmin = 0 }) =>
  db.prepare(`INSERT INTO users (user_id, nickname, password_hash, is_admin) VALUES (?, ?, ?, ?)`)
    .run(userId, nickname, passwordHash, isAdmin ? 1 : 0);

// ---------- 赛期 / 参赛记录 ----------
db.getOpenSeason = () => db.prepare(`SELECT * FROM seasons WHERE status='open'`).get();
db.getSeason = (id) => db.prepare(`SELECT * FROM seasons WHERE id=?`).get(id);
db.listSeasons = () => db.prepare(`SELECT * FROM seasons ORDER BY id DESC`).all();
db.getLastSeason = () => db.prepare(`SELECT * FROM seasons ORDER BY id DESC LIMIT 1`).get();

db.countPlayers = (seasonId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE season_id=? AND score IS NOT NULL`).get(seasonId).n;

db.findEntry = (seasonId, userId) =>
  db.prepare(`SELECT * FROM entries WHERE season_id=? AND user_id=?`).get(seasonId, userId);

db.getEntry = (id) => db.prepare(`SELECT * FROM entries WHERE id=?`).get(id);

db.getOrCreateEntry = (seasonId, userId) => {
  db.prepare(`INSERT OR IGNORE INTO entries (season_id, user_id) VALUES (?, ?)`).run(seasonId, userId);
  return db.findEntry(seasonId, userId);
};

db.getLineupImages = (entryId) =>
  db.prepare(`SELECT * FROM lineup_images WHERE entry_id=? ORDER BY id`).all(entryId);

db.getLineupImage = (id) => db.prepare(`SELECT * FROM lineup_images WHERE id=?`).get(id);

// R2：积分降序 → 提交时间升序 → id 升序
db.getRanking = (seasonId) => db.prepare(`
  SELECT e.*, u.user_id AS uid, u.nickname
  FROM entries e JOIN users u ON u.id = e.user_id
  WHERE e.season_id = ? AND e.score IS NOT NULL
  ORDER BY e.score DESC, e.score_submitted_at ASC, e.id ASC
`).all(seasonId);

// 已结算期的最终名次（名次由结算时写入，这里按它排，容错兜底再按分数）
db.getFinalRanking = (seasonId) => db.prepare(`
  SELECT e.*, u.user_id AS uid, u.nickname
  FROM entries e JOIN users u ON u.id = e.user_id
  WHERE e.season_id = ? AND e.score IS NOT NULL
  ORDER BY e.final_rank IS NULL, e.final_rank ASC, e.score DESC, e.score_submitted_at ASC, e.id ASC
`).all(seasonId);

// 本期阵容墙：所有传了阵容的人，**不限于交了积分的**。
// 只看 ranking 是不够的 —— 新开一期时常常是「有人传了阵容但还没人交积分」，
// 那样墙会是空的。
// 展示顺序按**互评均分**从高到低（没人打分的垫底），不是按积分 ——
// 积分排名是上面那张表的活儿，墙这边大家想看的是「哪套阵容公认最好」。
// 但 rank 仍然按积分序算出来（见下），所以卡上的 #N 是**积分名次**，和排名表对得上，
// 只是不再等于「墙上的第几张」。
// lineup_note 也一起带出来：墙上除了第一张图还要展示阵容说明（模板里按行截断，
// 卡片只有 200px 宽，1000 字的说明全摊开会把整行卡片顶得老高）。
// viewerId 用来认出「我给他打了多少」，卡上要把这一档标出来（别人打的不用管）。
db.getLineupWall = (seasonId, viewerId) => {
  const rows = db.prepare(`
    SELECT e.id, e.score, e.score_submitted_at, e.lineup_note, u.user_id AS uid, u.nickname
    FROM entries e JOIN users u ON u.id = e.user_id
    WHERE e.season_id = ?
      AND EXISTS (SELECT 1 FROM lineup_images li WHERE li.entry_id = e.id)
      AND (e.score IS NOT NULL OR u.is_disabled = 0)
    ORDER BY e.score IS NULL, e.score DESC, e.score_submitted_at ASC, e.id ASC
  `).all(seasonId);

  // 一期的打分一次全查回来，在 JS 里按 entry_id 归并（见 summarizeRatings）。
  // 打分是「人数 × 阵容数」，量级很小，不值得为它写一堆 GROUP BY、再逐个回查打分人。
  const ratings = db.summarizeRatings(db.getSeasonRatings(seasonId), viewerId);

  // 只有交了积分的才有名次；没交的排最后且 rank 为 null。
  // rank 按上面那条 SQL 的顺序（= 积分序）数出来，所以它始终是积分名次，
  // 和下面重排展示顺序无关。
  let rank = 0;
  const wall = rows.map((r) => ({
    ...r,
    rank: r.score === null ? null : ++rank,
    images: db.getLineupImages(r.id),
    rating: ratings.get(r.id) || db.EMPTY_RATING,
  }));

  // 互评均分高的在前。没人打分的 avg 是 null，一律沉底。
  // 均分相同的保持前面的积分序（sort 稳定），等于回落到「积分高者在前」，
  // 不再另立一套同分规则。
  const avgOf = (r) => (r.rating.avg === null ? -1 : r.rating.avg);
  return wall.sort((a, b) => avgOf(b) - avgOf(a));
};

// 还没交积分的启用成员（R12：被禁用的不列出）
db.getNotSubmitted = (seasonId) => db.prepare(`
  SELECT u.user_id AS uid, u.nickname, e.id AS entry_id, e.lineup_note,
         EXISTS (SELECT 1 FROM lineup_images li WHERE li.entry_id = e.id) AS lineup_uploaded
  FROM users u
  LEFT JOIN entries e ON e.user_id = u.id AND e.season_id = ?
  WHERE u.is_disabled = 0 AND (e.id IS NULL OR e.score IS NULL)
  ORDER BY u.id
`).all(seasonId);

// 某一期里所有上传过的图片文件名（删赛期时用来清磁盘）
db.collectSeasonFiles = (seasonId) => {
  const scoreFiles = db.prepare(
    `SELECT score_image AS f FROM entries WHERE season_id=? AND score_image IS NOT NULL`).all(seasonId);
  const lineupFiles = db.prepare(
    `SELECT li.filename AS f FROM lineup_images li
     JOIN entries e ON e.id = li.entry_id WHERE e.season_id=?`).all(seasonId);
  return [...scoreFiles, ...lineupFiles].map((r) => r.f);
};

// ---------- 打分（成员互评） ----------
// 五档固定分数。**唯一真源** —— schema.sql 的注释、路由的校验、模板里的按钮全看这里，
// 改档位只改这一行。也正因为要能随手改，ratings.value 上才没写 CHECK 约束。
const RATE_VALUES = [50, 200, 250, 300, 400];
db.RATE_VALUES = RATE_VALUES;

// 没人打过分时的形状。模板直接读，不用到处判空；冻结只是提醒别改它。
db.EMPTY_RATING = Object.freeze({
  n: 0, avg: null, max: null, min: null, maxBy: [], minBy: [], mine: null,
});

// 我给他打过没有。打过就锁死了 —— 一期内一个阵容只能打一次
db.findRating = (entryId, raterId) =>
  db.prepare(`SELECT * FROM ratings WHERE entry_id=? AND rater_id=?`).get(entryId, raterId);

db.getRating = (id) => db.prepare(`
  SELECT r.*, rater.nickname AS rater_name, target.nickname AS target_name
  FROM ratings r
  JOIN users   rater  ON rater.id  = r.rater_id
  JOIN entries e      ON e.id      = r.entry_id
  JOIN users   target ON target.id = e.user_id
  WHERE r.id = ?
`).get(id);

// 一期里的全部打分 + 打分人昵称。高位在前、同分先投的在前 —— 下面归并时
// 最高分和最低分的第一个名字，就是「第一个给出这个分的人」。
db.getSeasonRatings = (seasonId) => db.prepare(`
  SELECT r.entry_id, r.rater_id, r.value, r.created_at,
         u.user_id AS uid, u.nickname
  FROM ratings r
  JOIN entries e ON e.id = r.entry_id
  JOIN users   u ON u.id = r.rater_id
  WHERE e.season_id = ?
  ORDER BY r.value DESC, r.created_at ASC, r.id ASC
`).all(seasonId);

// 管理页要的是原始记录（带 id 才能删），而且打分人和被打分人都要
db.listSeasonRatings = (seasonId) => db.prepare(`
  SELECT r.id, r.value, r.created_at,
         target.user_id AS target_uid, target.nickname AS target_name,
         rater.user_id  AS rater_uid,  rater.nickname  AS rater_name
  FROM ratings r
  JOIN entries e      ON e.id      = r.entry_id
  JOIN users   target ON target.id = e.user_id
  JOIN users   rater  ON rater.id  = r.rater_id
  WHERE e.season_id = ?
  ORDER BY target.id, r.value DESC, r.id
`).all(seasonId);

// rows（getSeasonRatings 的结果）→ Map<entry_id, summary>
// summary = { n, avg, max, min, maxBy, minBy, mine }
// maxBy / minBy 把**并列的人全给**：只有五档，并列太常见了，只挑一个人显示是误导。
// 展示时截前两个，见 app.js 的 nameList。
db.summarizeRatings = (rows, viewerId) => {
  const byEntry = new Map();

  for (const r of rows) {
    let s = byEntry.get(r.entry_id);
    if (!s) {
      s = { n: 0, sum: 0, max: -Infinity, min: Infinity, maxBy: [], minBy: [], mine: null };
      byEntry.set(r.entry_id, s);
    }
    s.n++;
    s.sum += r.value;

    const who = { uid: r.uid, nickname: r.nickname };
    if (r.value > s.max) { s.max = r.value; s.maxBy = [who]; }
    else if (r.value === s.max) s.maxBy.push(who);
    if (r.value < s.min) { s.min = r.value; s.minBy = [who]; }
    else if (r.value === s.min) s.minBy.push(who);

    if (r.rater_id === viewerId) s.mine = r.value;   // UNIQUE 保证最多一条
  }

  for (const s of byEntry.values()) {
    s.avg = Math.round((s.sum / s.n) * 10) / 10;   // 保留 1 位；整数时 JS 直接打印成 250
    delete s.sum;
  }
  return byEntry;
};

// 我的全部打分记录（跨期），新的在前
db.getMyRatings = (userPk) => db.prepare(`
  SELECT r.value, r.created_at, e.id AS entry_id,
         s.id AS season_id, s.name AS season_name, s.status AS season_status,
         u.user_id AS uid, u.nickname
  FROM ratings r
  JOIN entries e ON e.id = r.entry_id
  JOIN seasons s ON s.id = e.season_id
  JOIN users   u ON u.id = e.user_id
  WHERE r.rater_id = ?
  ORDER BY s.id DESC, r.created_at DESC, r.id DESC
`).all(userPk);

// ---------- 统计（只算已结算的期，有积分才算参赛） ----------
const STATS_SQL = `
  SELECT u.user_id AS uid, u.nickname,
         SUM(e.is_winner)                               AS wins,
         COUNT(*)                                       AS plays,
         ROUND(100.0 * SUM(e.is_winner) / COUNT(*), 1)  AS win_rate,
         ROUND(AVG(e.score), 1)                         AS avg_score,
         MAX(e.score)                                   AS best_score,
         MIN(e.final_rank)                              AS best_rank
  FROM entries e
  JOIN seasons s ON s.id = e.season_id AND s.status = 'settled'
  JOIN users   u ON u.id = e.user_id
  WHERE e.score IS NOT NULL`;

db.getRankBoard = () => db.prepare(`${STATS_SQL}
  GROUP BY u.id
  ORDER BY wins DESC, win_rate DESC, plays DESC, u.id ASC`).all();

db.getUserStats = (userPk) => db.prepare(`${STATS_SQL} AND u.id = ? GROUP BY u.id`).get(userPk);

db.getUserHistory = (userPk) => db.prepare(`
  SELECT s.id, s.name, s.created_at, e.score, e.final_rank, e.is_winner,
         (SELECT COUNT(*) FROM entries x WHERE x.season_id = s.id AND x.score IS NOT NULL) AS players
  FROM entries e JOIN seasons s ON s.id = e.season_id
  WHERE e.user_id = ? AND s.status = 'settled' AND e.score IS NOT NULL
  ORDER BY s.id DESC`).all(userPk);

db.getHistory = () => db.prepare(`
  SELECT s.*, u.nickname AS winner_name, u.user_id AS winner_uid, e.score AS winner_score,
         (SELECT COUNT(*) FROM entries x WHERE x.season_id = s.id AND x.score IS NOT NULL) AS players
  FROM seasons s
  LEFT JOIN entries e ON e.season_id = s.id AND e.is_winner = 1
  LEFT JOIN users   u ON u.id = e.user_id
  ORDER BY s.id DESC`).all();

// ---------- 结算 / 撤销（一个事务里做完） ----------
db.settleSeason = db.transaction((seasonId) => {
  const ranking = db.getRanking(seasonId);
  const setRank = db.prepare(`UPDATE entries SET final_rank=?, is_winner=? WHERE id=?`);
  ranking.forEach((row, i) => setRank.run(i + 1, i === 0 ? 1 : 0, row.id));
  db.prepare(`UPDATE seasons SET status='settled', settled_at=? WHERE id=?`)
    .run(new Date().toISOString(), seasonId);
  return ranking;
});

db.reopenSeason = db.transaction((seasonId) => {
  db.prepare(`UPDATE entries SET final_rank=NULL, is_winner=0 WHERE season_id=?`).run(seasonId);
  db.prepare(`UPDATE seasons SET status='open', settled_at=NULL WHERE id=?`).run(seasonId);
});

module.exports = db;
