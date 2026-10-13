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

// 轻量迁移。schema.sql 里全是 CREATE TABLE IF NOT EXISTS —— 对**已经存在**的表
// 一个字都不会改，所以给老库补列（或补表）得在这儿单独来一次。
// 判据是 PRAGMA 里看这个列在不在，跑多少次都幂等；新库建表时已经带上了，直接跳过。
{
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (!cols.includes('eye_level')) {
    db.exec(`ALTER TABLE users ADD COLUMN eye_level INTEGER NOT NULL DEFAULT 10`);
  }
}

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

// uid（小写）→ 慧眼等级。**展示专用**：昵称出现的地方都要带那个小圆框，
// 而各个列表查出来的字段五花八门（多数只有一个 uid，没有 users.id），
// 与其给十处 SQL 各补一列 JOIN，不如每次请求拉这一张小表 —— 成员就十几个人。
db.getEyeLevels = () => {
  const m = new Map();
  for (const u of db.prepare(`SELECT user_id, eye_level FROM users`).all()) {
    m.set(u.user_id.toLowerCase(), u.eye_level);
  }
  return m;
};

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

// 上一期的积分第一 / 第二是谁 —— 阵容墙给他们的卡描边（亮蓝 / 亮银）。
// 「上一期」= 这一期之前**最近一个已结算的期**；没有就返回空表
// （第一期，或者上一期还没结算 —— 这两种情况下墙上一条边都不描）。
// 名次取 final_rank：它是结算时定死的，之后改不了（已结算期不允许改积分，见 routes/admin.js）。
db.getPrevAces = (seasonId) => {
  const aces = new Map();                                    // users.id → 1 | 2
  const prev = db.prepare(
    `SELECT id FROM seasons WHERE id < ? AND status='settled' ORDER BY id DESC LIMIT 1`).get(seasonId);
  if (!prev) return aces;
  db.getFinalRanking(prev.id).slice(0, 2).forEach((row, i) => aces.set(row.user_id, i + 1));
  return aces;
};

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
// ace 是「上一期的积分第一/第二」（1 / 2），模板据此给卡描亮蓝/亮银边；其余人是 null。
db.getLineupWall = (seasonId, viewerId) => {
  const rows = db.prepare(`
    SELECT e.id, e.user_id, e.score, e.score_submitted_at, e.lineup_note, u.user_id AS uid, u.nickname
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
  // ace 取的是**上一期**的名次（跨期查，见 getPrevAces），和本期的 rank 没有任何关系：
  // 一个是"你上期第几"（决定边框），一个是"你这期第几"（决定 #N）。
  const aces = db.getPrevAces(seasonId);
  let rank = 0;
  const wall = rows.map((r) => ({
    ...r,
    rank: r.score === null ? null : ++rank,
    ace: aces.get(r.user_id) || null,
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

// 每期每人给某一档的**名额上限**。没列出来的档位不限（50 / 200 想投几张投几张）。
// 高分票是稀缺资源：给谁 400 得先想清楚，不能一口气全撒出去。
// 同样是产品参数，改规矩只改这一行。
// 它**不落库**：名额不是存下来的计数器，而是每次按 ratings 现数（见 getMyQuota）——
// 于是改这张表对已经在投的这期立刻生效，管理员在 /admin 删掉一条票也当场退还名额，
// 不会出现"计数器说用完了、记录里却翻不出那张票"的对不上。
const RATE_QUOTA = { 400: 2, 300: 3, 250: 4 };
db.RATE_QUOTA = RATE_QUOTA;

// 打分的**截止时刻**：每期开期后遇到的第一个周四 12:00（北京时间）。过点整期封盘 ——
// 那一期再也投不出新票、也改不了已投的，一直等到管理员结算（结算后连按钮都不出）。
//
// 为什么要给打分设截止：打分不进名次，但**结算时按"有没有看准前两名"涨慧眼等级**
// （见下面的 applyEye）。名次基本明朗之后再补票、再改分，等于照着答案改卷子。
// 周四 12:00 这个时点是用户定的。
//
// 和名额一样**不落库**：截止点按 seasons.created_at 现算。于是「撤销结算」
// （created_at 不动）、改规矩（只改下面两个常数）都自动生效，也不会出现
// "库里存着一个时间、规则又算出另一个时间"的两套说法。
// 时区固定北京：全站时间都按 Asia/Shanghai 显示，而北京时间没有夏令时，
// 固定 +8 小时就够，不用 Intl 也不用时区库。
const LOCK_WEEKDAY = 4;                   // 4 = 周四（getUTCDay 口径，0 是周日）
const LOCK_HOUR_BJ = 12;                  // 北京时间正午
const BJ_OFFSET_MS = 8 * 3600 * 1000;     // 北京 = UTC+8

// 这一期的打分截止时刻（毫秒时间戳），没有有效的 created_at 就返回 null。
// 取**严格晚于** created_at 的那一个周四 12:00：万一正好卡在周四 12:00:00.000 开期，
// 算下一周 —— 否则那一期一开出来就是封盘的。
db.getRateLockAt = (season) => {
  const created = Date.parse(season?.created_at ?? '');
  if (!Number.isFinite(created)) return null;

  // 把"北京墙上时间"借 UTC 的字段读出来：created + 8h 之后，getUTC* 拿到的就是北京的日期
  const d = new Date(created + BJ_OFFSET_MS);
  // 12:00 北京 = 04:00 UTC，所以拿日期直接凑出当天那个时刻，再一天天往后找周四
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), LOCK_HOUR_BJ - 8);
  for (let i = 0; i < 8; i++) {           // 最多往后 7 天，必中
    if (t > created && new Date(t + BJ_OFFSET_MS).getUTCDay() === LOCK_WEEKDAY) break;
    t += 86400000;
  }
  return t;
};

// 这一期封盘了没有。**只看时间**，不看 status：已结算的期由别处挡着
// （结算后连打分区都不出），这里管的是"还开着、但已经过了周四 12:00"。
db.isRateLocked = (season) => {
  const at = db.getRateLockAt(season);
  return at !== null && Date.now() >= at;
};

// 没人打过分时的形状。模板直接读，不用到处判空；冻结只是提醒别改它。
db.EMPTY_RATING = Object.freeze({
  n: 0, avg: null, max: null, min: null, maxBy: [], minBy: [], mine: null,
});

// 我给他打过没有。一期内一个阵容只有一票（UNIQUE(entry_id, rater_id) 兜底），
// 但**截止前随时能改**：改分就是 UPDATE 这一行，见 routes/main.js。
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

// 本期我各档还剩几个名额：[{ value, quota, used, left }]，高档在前（400 → 300 → 250）。
// 只列**有名额限制**的档位 —— 不限的档位没有"还剩几个"这回事，模板不用知道它们。
// 期由 entry 带出来（ratings 表里没存 season_id，见 schema.sql）。
//
// 现数还有个附带的好处：**改分时旧档位的名额当场退回来**。把一张 400 改成 50，
// 这一查就只剩一张 400 了，不用额外写"退名额"的代码，也不会退错。
//
// 名额是后加的规矩，所以老数据可能**已经超了**（比如有人手里已经投出去三个 400）：
// 他的票一条不动，只是这里把 left 归零 —— 后果是他这期不能再投 400。
// 从"删掉两张票把名额腾出来"和"既往不咎、从下一张开始挡"里选了后者：
// 票是成员对阵容的评价，规矩不该回头改写已经投过的票。
db.getMyQuota = (seasonId, raterId) => {
  const used = new Map(db.prepare(`
    SELECT r.value, COUNT(*) AS n
    FROM ratings r JOIN entries e ON e.id = r.entry_id
    WHERE e.season_id = ? AND r.rater_id = ?
    GROUP BY r.value
  `).all(seasonId, raterId).map((r) => [r.value, r.n]));

  return Object.entries(RATE_QUOTA)
    .map(([value, quota]) => {
      const n = used.get(Number(value)) || 0;
      return { value: Number(value), quota, used: n, left: Math.max(0, quota - n) };
    })
    .sort((a, b) => b.value - a.value);
};

// rows（getSeasonRatings 的结果）→ Map<entry_id, summary>
// summary = { n, avg, max, min, maxBy, minBy, mine }
// maxBy / minBy 把**并列的人全给**：只有五档，并列太常见了，只挑一个人显示是误导。
// 展示时截前两个，见 views/partials/name-list.ejs。
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

// ---------- 慧眼等级 ----------
// 所有人初始 10 级（users.eye_level 的 DEFAULT），**只在结算那一刻**动，而且只动
// "给本期积分第一/第二的人打过分的"那几个人 —— 奖励的是"看准了冠军"的眼光，
// 不是按人头普涨。**自评也算**（本站不禁止自评，一视同仁，见 README）。
// "只认前两名"是**唯一和名次有关的地方**（第三名往后一分不加，这是有意的）；
// 除此之外名次不再有别 —— 给第二名的分和给第一名一样算，见下。
//
// 给**积分第一/第二**的人打分时的增减。这是唯一真源，整站就这一张表。
// ⚠️ 键就是 RATE_VALUES 的五个档位，改档位时这里必须一起改；
// 对不上的档位（比如老数据里已下线的档位）按 0 处理：不涨不跌，也不写记录。
//
// 2026-10-13 改了两处：
//  1. **50 和 200 不再扣等级**（原本是 −2 / −1）。打低分的意思是"我觉得他打得一般"，
//     不该倒扣眼光 —— 于是所有增减都 ≥ 0，**慧眼等级只涨不跌**，初始那 10 级就是地板。
//     这两个键留着并显式写 0（而不是删掉），为的是让人一眼看出五个档位都考虑过、
//     它俩是有意给 0，而不是漏了一档。
//  2. **第二名不再减半**（原本是这张表减半向零取整，于是只有 400 / 300 给 +1）：
//     看准第二名和看准第一名一样值钱。两张表并成一张之后，`eyeDelta` 就只剩一次查表，
//     连 rank 参数都去掉了 —— 留着它会让人以为名次还参与计算。
const EYE_GAIN = { 400: 3, 300: 2, 250: 1, 200: 0, 50: 0 };
db.eyeDelta = (value) => EYE_GAIN[value] ?? 0;

// 结算时把慧眼等级算出来并落库。ranking 是 getRanking 的结果（积分序、已含 user_id）。
// 一期一人写一行，先把这个人的所有票加起来（他可能既给第一打了 400、又给第二打了 250）。
const applyEye = (seasonId, ranking) => {
  // 本期前两名的 entry_id。名次本身已经不参与计算了（第一和第二同一张表），
  // 这个集合只用来筛掉"给第三名往后打的票"；本期不足两人时集合里就只有一条。
  const top2 = new Set(ranking.slice(0, 2).map((row) => row.id));

  const deltas = new Map();                       // users.id → 本期净增减
  for (const r of db.getSeasonRatings(seasonId)) {
    if (!top2.has(r.entry_id)) continue;          // 不是给前两名打的，跟他没关系
    const d = db.eyeDelta(r.value);
    if (d) deltas.set(r.rater_id, (deltas.get(r.rater_id) || 0) + d);
  }

  const ins = db.prepare(`INSERT INTO eye_adjustments (season_id, user_id, delta) VALUES (?, ?, ?)`);
  const bump = db.prepare(`UPDATE users SET eye_level = eye_level + ? WHERE id = ?`);
  for (const [userId, delta] of deltas) {
    ins.run(seasonId, userId, delta);             // 净增减为 0 的人上面已经滤掉了
    bump.run(delta, userId);
  }
};

// 把某一期结算时加过的等级**原样退回去**。撤销结算、删除赛期都要先走这一步：
// 不退的话「撤销 → 重新结算」会累加两次，删掉一期也会给人留下白拿的等级。
db.revertEye = (seasonId) => {
  const rows = db.prepare(`SELECT user_id, delta FROM eye_adjustments WHERE season_id=?`).all(seasonId);
  const bump = db.prepare(`UPDATE users SET eye_level = eye_level - ? WHERE id = ?`);
  for (const r of rows) bump.run(r.delta, r.user_id);
  db.prepare(`DELETE FROM eye_adjustments WHERE season_id=?`).run(seasonId);
  return rows.length;
};

// 某一期结算时的等级变动，给管理页的结算提示用（撤销后就是空的）。
db.getEyeAdjustments = (seasonId) => db.prepare(`
  SELECT a.delta, u.nickname, u.user_id AS uid
  FROM eye_adjustments a JOIN users u ON u.id = a.user_id
  WHERE a.season_id = ?
  ORDER BY a.delta DESC, u.id ASC
`).all(seasonId);

// ---------- 结算 / 撤销（一个事务里做完） ----------
db.settleSeason = db.transaction((seasonId) => {
  const ranking = db.getRanking(seasonId);
  const setRank = db.prepare(`UPDATE entries SET final_rank=?, is_winner=? WHERE id=?`);
  ranking.forEach((row, i) => setRank.run(i + 1, i === 0 ? 1 : 0, row.id));
  // 先把这一期可能残留的慧眼明细退干净，再重新算。正常流程走不到这一步
  // （结算前必然是 open 期，而变回 open 只能经 reopenSeason，那里已经退过），
  // 但少了这句，一旦哪条路径漏了退，这里就会撞 eye_adjustments 的
  // UNIQUE(season_id, user_id) 直接抛错、把整个结算回滚掉 ——
  // 与其留个"结算失败"的雷，不如让结算天然幂等：算两遍结果一样。
  db.revertEye(seasonId);
  applyEye(seasonId, ranking);                    // 慧眼等级跟着名次一起定，同一个事务
  db.prepare(`UPDATE seasons SET status='settled', settled_at=? WHERE id=?`)
    .run(new Date().toISOString(), seasonId);
  return ranking;
});

db.reopenSeason = db.transaction((seasonId) => {
  db.revertEye(seasonId);                         // 先把等级退回去，否则重新结算会累加两次
  db.prepare(`UPDATE entries SET final_rank=NULL, is_winner=0 WHERE season_id=?`).run(seasonId);
  db.prepare(`UPDATE seasons SET status='open', settled_at=NULL WHERE id=?`).run(seasonId);
});

module.exports = db;
