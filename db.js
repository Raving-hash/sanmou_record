const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

// 图片自 2026-10-15 起存在 Cloudflare R2 上（浏览器直传），本地不再有任何图片目录，
// 所以这里不再 mkdirSync('uploads') —— 建一个永远为空的目录只会让人以为图还在本地。
fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });

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

// 游戏名（2026-10-17 加）：给 Windows 端的积分录入接口做「游戏名 → 本站用户」的匹配键。
// 列本身写在 schema.sql 里（新库直接建出来），这里只补老库。
// ★ 唯一索引必须排在**补完列之后**，而且只对非空值生效：
//   · 没填的人可以有一大堆 NULL（NULL 在 SQLite 的唯一索引里互不冲突）；
//   · 填了就必须唯一 —— 否则接口收到「张三 1200 分」时不知道该记给谁。
//   · NOCASE 只对纯英文名有意义（中文本来就没有大小写），但"Tom / tom 算同一个人"
//     正是我们想要的匹配口径。
// ★ 故意**不**把这条索引写进 schema.sql：老库执行 schema.sql 时这一列还不存在，
//   CREATE UNIQUE INDEX 会先于下面的 ALTER 抛错，整个进程起不来。
{
  const cols = db.prepare(`PRAGMA table_info(users)`).all().map((c) => c.name);
  if (!cols.includes('game_name')) db.exec(`ALTER TABLE users ADD COLUMN game_name TEXT`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_game_name
           ON users(game_name COLLATE NOCASE) WHERE game_name IS NOT NULL`);
}

// 识别改版（2026-10-16）：从"给候选让玩家点"改成"机器直接填、玩家事后纠正"，
// hero_guesses 要留住"机器原本说什么"，否则纠正数据无从分析。
{
  const cols = db.prepare(`PRAGMA table_info(hero_guesses)`).all().map((c) => c.name);
  if (!cols.includes('vlm')) db.exec(`ALTER TABLE hero_guesses ADD COLUMN vlm TEXT`);
  if (!cols.includes('auto_key')) db.exec(`ALTER TABLE hero_guesses ADD COLUMN auto_key TEXT`);
  if (!cols.includes('confidence')) db.exec(`ALTER TABLE hero_guesses ADD COLUMN confidence TEXT`);
}

// OCR 这一路（2026-10-16 加，2026-10-17 起是主路）：本地 OCR 认「自带战法名」→ 反查武将。
// 老库里这一列没有，补上；**补完之后是 NULL**，`filenamesMissingOcr()` 正是靠这个
// 把历史图扫出来（但那个入口是手动脚本，不进 sweep，理由见那个函数）。
{
  const cols = db.prepare(`PRAGMA table_info(hero_guesses)`).all().map((c) => c.name);
  if (!cols.includes('ocr')) db.exec(`ALTER TABLE hero_guesses ADD COLUMN ocr TEXT`);
}

// 武将库补 `skill`（自带战法名，OCR 的词典）。heroes 之前没有迁移块，这里开一个。
// ⚠️ 补出来是 NULL 是**正常且安全**的：identify 那一路会因此整体不启用，
//    行为退回到"只有 NCC"（recognize-ocr.js 的 available()）。
//    要真正启用，得把带 skill 的 herodata/index.json 放到线上目录（它 git-ignored，
//    release.sh 带不过去），重启进程让 seedHeroes 播种。
{
  const cols = db.prepare(`PRAGMA table_info(heroes)`).all().map((c) => c.name);
  if (!cols.includes('skill')) db.exec(`ALTER TABLE heroes ADD COLUMN skill TEXT`);
}

// 初步阵容图（2026-10-18 加的赛制改动）：周二 12:00–周三 12:00 传的那张**只作展示**，
// 不做识别、不计入武将数据、不算参赛；周三 12:00 之后的完整阵容图会把它覆盖掉。
// 判别就靠这一列：0 = 完整阵容图（老数据默认也是 0，行为不变），1 = 初步图。
// 查询"第一张图"的地方必须带 `AND is_preliminary = 0`（见下面的 FIRST_IMG）。
{
  const cols = db.prepare(`PRAGMA table_info(lineup_images)`).all().map((c) => c.name);
  if (!cols.includes('is_preliminary')) {
    db.exec(`ALTER TABLE lineup_images ADD COLUMN is_preliminary INTEGER NOT NULL DEFAULT 0`);
  }
}

// R4 改口径（2026-10-17 用户：「上传积分不需要再上传截图了，直接填写积分就可以」）：
// **积分截图从必填变成可选**，而分数和提交时间仍然同生共死。
// SQLite **改不了 CHECK**（不像加列那样 ALTER 一句就行），只能整表重建 ——
// 判据看 sqlite_master 里的建表语句：老口径那句里有 `score_image IS NOT NULL`。
// 重建就是官方那套的简化版：新表 → 拷数据 → 删旧表 → 改名 → 重建索引。跑几遍都幂等。
//
// ⚠️ 三步都不能省：
//   ① `foreign_keys = OFF` **必须在事务外**设（SQLite 在事务里改它是个空操作），
//      否则 DROP TABLE entries 会顺着 ON DELETE CASCADE 把 lineup_images / ratings /
//      comments / hero_guesses 里挂在这张表上的真数据一起清空。
//   ② 拷数据要**按列名列**，别写 `SELECT *` —— 将来列序一变就会静默错位。
//   ③ 重建完立刻 `foreign_key_check`，断了就抛，别带着坏库继续跑。
{
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='entries'`).get();
  if (row && /score_image IS NOT NULL/.test(row.sql)) {
    db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE entries_new (
            id                 INTEGER PRIMARY KEY,
            season_id          INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
            user_id            INTEGER NOT NULL REFERENCES users(id),
            lineup_note        TEXT,
            score              INTEGER,
            score_image        TEXT,
            score_submitted_at TEXT,
            final_rank         INTEGER,
            is_winner          INTEGER NOT NULL DEFAULT 0,
            UNIQUE (season_id, user_id),
            CHECK ((score IS NULL AND score_submitted_at IS NULL)
                OR (score IS NOT NULL AND score_submitted_at IS NOT NULL))
          );
          INSERT INTO entries_new
            (id, season_id, user_id, lineup_note, score, score_image,
             score_submitted_at, final_rank, is_winner)
            SELECT id, season_id, user_id, lineup_note, score, score_image,
                   score_submitted_at, final_rank, is_winner FROM entries;
          DROP TABLE entries;
          ALTER TABLE entries_new RENAME TO entries;
          CREATE INDEX IF NOT EXISTS idx_entries_season ON entries(season_id);
          CREATE INDEX IF NOT EXISTS idx_entries_user   ON entries(user_id);
        `);
      })();
      const broken = db.pragma('foreign_key_check');
      if (broken.length) {
        throw new Error(`entries 重建后外键不一致：${JSON.stringify(broken)}`);
      }
    } finally {
      db.pragma('foreign_keys = ON');
    }
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

// 游戏名里**盟标分隔竖线**有几种写法，不能要求两边打的是同一个码点：
// 玩家在游戏里看到的是「善丨皮皮王」（丨 = U+4E28），OCR 常认成半角 `|`，
// 手机输入法还可能给出全角 `｜`。统一折成 丨 再比，见 normalizeGameName。
const GAME_NAME_SEP = /[|｜丨│┃]/g;
const normalizeGameName = (name) =>
  String(name ?? '').trim().replace(GAME_NAME_SEP, '丨').toLowerCase();
db.normalizeGameName = normalizeGameName;

// 按**游戏名**找本站用户。积分录入接口（POST /api/scores）唯一的反查入口。
// 大小写不敏感（和 uniq_users_game_name 那条唯一索引同一个口径），前后空白在写入时
// 已经 trim 过，这里再 trim 一次是防接口调用方手滑多打空格。
// 分隔竖线按等价字符比（见上面），所以库里存的是哪种写法都能认出来。
// 用户只有几十个，直接拉出来在 JS 里比 —— 比在 SQL 里 REPLACE 五层清楚得多。
db.getUserByGameName = (name) => {
  const n = normalizeGameName(name);
  if (!n) return undefined;
  return db.prepare(`SELECT * FROM users WHERE game_name IS NOT NULL`).all()
    .find((u) => normalizeGameName(u.game_name) === n);
};

// 设置游戏名。本人（/password）和管理员（/admin）两条路共用这一份校验 ——
// 校验散成两份的话，总有一边会忘了查重名。
// 空串 = 清掉（还没填的人可以有很多个，见 uniq_users_game_name 的 WHERE）。
// 返回 { ok, name } 或 { ok: false, error }，由调用方决定 flash 文案。
db.setGameName = (userId, raw) => {
  const name = String(raw ?? '').trim();
  if (!name) {
    db.prepare(`UPDATE users SET game_name=NULL WHERE id=?`).run(userId);
    return { ok: true, name: null };
  }
  if ([...name].length > 32) return { ok: false, error: '游戏名最多 32 个字' };
  const taken = db.getUserByGameName(name);
  if (taken && taken.id !== userId) {
    return { ok: false, error: `「${name}」已经被 ${taken.nickname} 用了，换一个` };
  }
  db.prepare(`UPDATE users SET game_name=? WHERE id=?`).run(name, userId);
  return { ok: true, name };
};

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

// 参赛人数 = 这一期**上传过阵容或交过积分**的人（每人每期一条 entry，不会重复数）。
// 2026-10-15 用户改的口径：**只要上传了阵容就算参与本期**（从前只有交了积分才算，
// 于是"传了阵容但没录分"的人在历史/赛期页上连人数都不算，人数与实际到场的差一大截）。
db.countPlayers = (seasonId) => db.prepare(`
  SELECT COUNT(*) AS n FROM entries e
  WHERE e.season_id = ?
    AND (e.score IS NOT NULL OR EXISTS (SELECT 1 FROM lineup_images li WHERE li.entry_id = e.id))
`).get(seasonId).n;

// **交了积分**的人数 —— 和上面那个不是一个数，别混用。
// 只有两处要它：结算的前置条件（少于 2 人交分不能结算），以及页面上"参赛 N 人 · 交分 M 人"
// 里的那个 M。名单、名次、胜者永远只看交了积分的人（没分就没名次）。
db.countScored = (seasonId) =>
  db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE season_id=? AND score IS NOT NULL`).get(seasonId).n;

db.findEntry = (seasonId, userId) =>
  db.prepare(`SELECT * FROM entries WHERE season_id=? AND user_id=?`).get(seasonId, userId);

db.getEntry = (id) => db.prepare(`SELECT * FROM entries WHERE id=?`).get(id);

db.getOrCreateEntry = (seasonId, userId) => {
  db.prepare(`INSERT OR IGNORE INTO entries (season_id, user_id) VALUES (?, ?)`).run(seasonId, userId);
  return db.findEntry(seasonId, userId);
};

// 完整图永远排在初步图前面：模板（阵容墙、纠错面板）默认拿 images[0] 当"卡上那张"，
// 万一库里同时留着两种（理论上不会 —— 传完整图时会把初步图删掉），也该展示完整那张。
db.getLineupImages = (entryId) =>
  db.prepare(`SELECT * FROM lineup_images WHERE entry_id=?
              ORDER BY is_preliminary ASC, id`).all(entryId);

db.getLineupImage = (id) => db.prepare(`SELECT * FROM lineup_images WHERE id=?`).get(id);

// ---------- 武将库 / 识别结果（2026-10-16 加）----------

// 库的播种。**每次启动都跑一遍**，靠 upsert 保证幂等 ——
// 这样改了 herodata/index.json（补一个武将、修一个兵种）重启就生效，不用手工改库。
// 不删多余的 key：库里少一个武将时，历史上玩家对它的确认仍然要留着（见 schema.sql）。
db.seedHeroes = (heroes) => {
  // ⚠️ 这里**一定要把新字段也列出来** —— seedHeroes 传的是整个 `{...h}`，
  //    但 SQL 里没点名的列会被静默忽略。只改 herodata/index.json 不加这一列，
  //    表现是"改了 JSON 重启了却没生效"，很难查。
  const up = db.prepare(`
    INSERT INTO heroes (key, name, faction, arm, variant, skill, sort) VALUES (@key, @name, @faction, @arm, @variant, @skill, @sort)
    ON CONFLICT(key) DO UPDATE SET name=excluded.name, faction=excluded.faction,
                                   arm=excluded.arm, variant=excluded.variant,
                                   skill=excluded.skill, sort=excluded.sort`);
  db.transaction((rows) => rows.forEach((h, i) => up.run({
    ...h, variant: h.variant || null, skill: h.skill || null, sort: i,
  })))(heroes);
};

db.getHeroes = () => db.prepare(`SELECT * FROM heroes ORDER BY sort`).all();
db.getHero = (key) => db.prepare(`SELECT * FROM heroes WHERE key=?`).get(key);
// 按玩家手输的名字反查（「其他」输入框靠它把名字对回库里）。**可能返回多条**，
// 调用方自己决定怎么办。
//
// ⚠️ 唯一的调用方（routes/main.js）现在的口径是「**只收恰好一条**」：0 条和多条都不写库，
//    并在 flash 里点名。所以这份查询的每一档都存在意义 —— 第一档让补全列表里挑出来的
//    名字必然能过，后两档是给"照着卡上抄、但抄得不那么全"的人留的余地（「祝融」）。
//    **不要**为了"少一次查询"把后两档砍掉。
//
// ⚠️ 分三档，**按优先级来，不是取并集** —— 这个顺序是有实测依据的：
//   玩家在「其他」框里打的，多半是**照着卡上抄下来的显示名**，而显示名 = variant + name。
//   从前这里只比 `name`，于是「群雄孙坚」「SP周瑜」一条都对不上（它们的 name 只是
//   「孙坚」「周瑜」，前缀存在 variant 里）；「诸葛亮」更冤 —— 库里两个诸葛亮 name 都是
//   「诸葛亮」，精确匹配返回两条，撞上调用方的 `hits.length === 1` 直接放弃。
//   2026-10-16 实测：玩家标注的 17 条手输里有 5 条是这么丢的，其中「祝融」还是 T0，
//   害得那条 T0 高亮一直不亮。
//
//   ① 显示名精确命中 —— 「群雄孙坚」「SP周瑜」「诸葛亮」都在这儿落到唯一一条
//   ② name 精确命中   —— 显示名对不上时退回老口径（可能有同名多条）
//   ③ 前缀兜底        —— 只认**唯一命中**：玩家会把「祝融夫人」打成「祝融」，
//                        但打「孙」能命中孙权/孙尚香/孙坚/孙策，那种宁可不认
db.findHeroesByName = (raw) => {
  const name = String(raw || '').trim();
  if (!name) return [];

  const byDisplay = db.prepare(
    `SELECT * FROM heroes WHERE COALESCE(variant,'') || name = ? ORDER BY sort`).all(name);
  if (byDisplay.length) return byDisplay;

  const byName = db.prepare(`SELECT * FROM heroes WHERE name = ? ORDER BY sort`).all(name);
  if (byName.length) return byName;

  // LIKE 里 % 和 _ 是通配符，玩家真打了这两个字符就得转义，否则「张%」会命中一片
  const escaped = name.replace(/[\\%_]/g, '\\$&');
  const byPrefix = db.prepare(
    `SELECT * FROM heroes WHERE name LIKE ? ESCAPE '\\' ORDER BY sort`).all(escaped + '%');
  return byPrefix.length === 1 ? byPrefix : [];
};

// 一张图的 9 行。没识别过就是空数组。
db.getGuesses = (filename) =>
  db.prepare(`SELECT * FROM hero_guesses WHERE filename=? ORDER BY slot`).all(filename);

db.getEntryGuesses = (entryId) =>
  db.prepare(`SELECT * FROM hero_guesses WHERE entry_id=? ORDER BY filename, slot`).all(entryId);

// 写入识别结果（机器那一路）。一张图的 9 行一次写完，幂等。
//
// ★ 整个 Upsert 的关键是那几个 `CASE ... decided_at IS NULL`：
//   **有人核对过的格子，重跑识别一律不许覆盖。** 这是"定期重跑"能安全存在的前提 ——
//   否则补一次识别就把玩家所有的纠正冲掉了。decided_at 是判据（只有人动过才会写它）。
//   candidates / ocr / confidence 是"机器当时看到什么"，无条件刷新；auto_key 也是
//   —— 它记的是机器的意见，玩家改的是 chosen_key，两者本来就该分开存。
//
// ★ 2026-10-17 用户砍掉了远端视觉模型（「去除视觉模型，OCR 认不出就 NCC」）：
//   `vlm` 这一列从此是**历史存档**，不再有新的写入。更新的那一句写成 COALESCE，
//   是为了**别让一次重跑把老行里的 VLM 快照抹成 NULL**（新行本来就没有，仍是 NULL）。
db.saveGuesses = (entryId, filename, list) => {
  const up = db.prepare(`
    INSERT INTO hero_guesses (entry_id, filename, slot, candidates, vlm, ocr, auto_key, confidence, chosen_key, source)
    VALUES (@entry_id, @filename, @slot, @candidates, @vlm, @ocr, @auto_key, @confidence, @auto_key, 'auto')
    ON CONFLICT(filename, slot) DO UPDATE SET
      candidates = excluded.candidates,
      vlm        = COALESCE(excluded.vlm, hero_guesses.vlm),
      ocr        = excluded.ocr,
      confidence = excluded.confidence,
      auto_key   = excluded.auto_key,
      chosen_key = CASE WHEN hero_guesses.decided_at IS NULL THEN excluded.chosen_key ELSE hero_guesses.chosen_key END,
      source     = CASE WHEN hero_guesses.decided_at IS NULL THEN excluded.source     ELSE hero_guesses.source     END`);
  db.transaction((rows) => rows.forEach((g) => up.run({
    entry_id: entryId, filename, slot: g.slot,
    candidates: JSON.stringify(g.candidates || []),
    // ⚠️ 判空必须是 `== null`，**不能写成 `g.ocr ? ... : null`** ——
    //    空数组 `[]` 在 JS 里是真值，那样写会把"这一路跑了但这格没候选"也存成 NULL，
    //    两种含义就再也分不开了（`filenamesMissingOcr` 的 `IS NULL` 判据全靠它）。
    vlm: g.vlm == null ? null : JSON.stringify(g.vlm),
    ocr: g.ocr == null ? null : JSON.stringify(g.ocr),
    auto_key: g.auto_key || null,
    confidence: g.confidence || null,
  })))(list);
};

// 玩家纠正一格。source: 'pick' | 'other' | 'none'
// 写 decided_at 就是"有人核对过"的标记（见 schema.sql）。**auto_key 一个字节都不动。**
// ⚠️ `other_name` 现在**只在 key 也对上了库的时候才有值**（2026-10-16 晚起，
//    "只有英雄库中的名字才允许保存"，见 routes/main.js）—— 它变成了"玩家当时打的那几个字"
//    这份旁证，而不是"库里没有的名字"的收容所。历史上那种 key=null 的遗留行还在库里、
//    也照样显示（views/admin.ejs 的"对不上的名字"那一块），但不会再有新的。
db.decideGuess = (filename, slot, { key = null, source, otherName = null }) =>
  db.prepare(`UPDATE hero_guesses SET chosen_key=?, source=?, other_name=?, decided_at=?
              WHERE filename=? AND slot=?`)
    .run(key, source, otherName, new Date().toISOString(), filename, slot);

// 还没识别过的阵容图（启动时补跑那些进程重启前没轮到、或当时失败的）。
// 判据是"这张图在 hero_guesses 里一行都没有"。
// ★ **只补完整阵容图**：初步图（周二到周三那一段）明确"不做识图"，进程重启不能把
//   这条规矩绕过去 —— 排除在这里，而不是让 recognize-worker 自己去判阶段
//   （阶段性是上传那一刻定下的，之后时间再走也不该补跑）。
db.filenamesMissingGuesses = () => db.prepare(`
  SELECT DISTINCT li.filename, li.entry_id FROM lineup_images li
  WHERE li.is_preliminary = 0
    AND NOT EXISTS (SELECT 1 FROM hero_guesses g WHERE g.filename = li.filename)`).all();

// 还没跑过本地 OCR 的阵容图。
//
// ⚠️ **这个函数只有一个调用方：scripts/reco-backfill-ocr.js（手动跑）。**
//    故意**不接进 recognize-worker 的 sweep**：runJob 会重取图、重跑 NCC（2.5 秒/张），
//    几百张历史图推给 sweep 就是一次白跑。想补历史图就显式跑那个脚本。
//    （2026-10-17 移除了视觉模型之后，这条补跑仍然是"只补 ocr 那一列、拿库里的 NCC
//    快照重新 merge"，所以很便宜。）
//
// ⚠️ **历史遗留**：2026-10-16 之前的 saveGuesses 会把"跑了但没候选"也存成 `'[]'`，
//    所以老库里的 `'[]'` **不能**当作"还没跑过"。修好之后新写入的行才会正确区分
//    NULL（这一路没跑）/ `[]`（跑了但这格没候选）（见 saveGuesses 和 merge 的注释）。
db.filenamesMissingOcr = () => db.prepare(`
  SELECT DISTINCT g.filename, g.entry_id FROM hero_guesses g
  WHERE g.ocr IS NULL`).all();

// （2026-10-16 删掉了 getConfirmedHeroes —— 它是上一版的遗留，没有任何调用方
//   （阵容墙走的是 getSeasonHeroData 的批量版），而且改版后"已确认"这个说法本身
//   就不成立了：机器填的也算数。留着只会误导下一个人。）

// ★ T0 名单。**用户 2026-10-16 手工给的 7 个**，2026-10-22 又加了 SP周瑜（现 8 个）——
// 按 key 写而不是按名字：名字不是唯一键（诸葛亮 / SP诸葛亮 同名不同人），
// 写名字将来一定会认错人。
// 和 RATE_VALUES / TOP_N 一个路数：产品参数、单一真源、改的时候改这一处。
// ⚠️ 注意 `huang_pu_song2`：皇甫嵩有紫/橙两版，紫的那版（huang_fu_song）已按用户要求丢弃，
//    留下的是这张橙卡，显示名仍叫「皇甫嵩」。
db.T0_HEROES = new Set([
  'zhu_rong_fu_ren',  // 祝融夫人（用户说的「祝融」在库里是这个全名）
  'si_ma_yi',         // 司马懿
  'lu_xun',           // 陆逊
  'jiang_wei',        // 姜维
  'huang_pu_song2',   // 皇甫嵩
  'wang_yi',          // 王异
  'zuo_ci',           // 左慈
  'zhou_yu2',         // SP周瑜（2026-10-22 用户加的；普通周瑜 zhou_yu 不是）
]);
db.isT0 = (key) => db.T0_HEROES.has(key);

// ★ 阵容评级的底表：**双人搭配**的等级（用户 2026-10-16 手工给的 23 组，
//    2026-10-17 又补了「左慈 + 陆逊」进 T1，2026-10-22 把「SP周瑜 + 诸葛亮」
//    从 T1 升进 T0，现共 24 组：T0 12 / T1 8 / T2 4）。
//    另有 1 组**三人搭配**（乐进 + 马腾 + 任一追击英雄），见下面的 LINEUP_TRIPLES。
// 注意它和上面那份 T0 名单**不是一回事**：T0_HEROES 是"单个武将够不够强"（卡上金色高亮用），
// 这里是"两个武将凑在一起算不算一套好搭配"（评级用）。一个武将可以既在 T0 名单里、
// 又出现在某几组搭配里，两者各算各的。
//
// ⚠️ **命中要求两人在同一支部队**（用户 2026-10-16 明确定的口径：是"搭配"，不是"凑齐了"）——
//    所以这个表不能只用 key 的集合去查，得按 slot 分组，见 db.lineupTier。
// ⚠️ 同名不同人靠 key 分：`zhu_ge_liang2` 是 SP诸葛亮（用户写的「sp诸葛」），
//    `zhou_yu2` 是 SP周瑜，`sun_jian2` 是群雄孙坚 —— 用户给的名单里就是这么区分的。
// ⚠️ 没提到的组合一律当 T3。
// 改这份表 = 改评级，只改这一处；`.devlocal/test/test-heroes.js` 第七节拿它当输入做断言。
// 一名一组写清楚（key + 中文对照），方便和用户给的那份名单逐行对着看。
const tierPairs = (tier, list) => list.map(([a, b]) => ({ a, b, tier }));
db.LINEUP_PAIRS = [
  ...tierPairs(0, [   // —— T0（12 组）——
    ['cao_pi', 'si_ma_yi'],           // 曹丕 + 司马懿
    ['zhang_chun_hua', 'si_ma_yi'],   // 张春华 + 司马懿
    ['zhang_chun_hua', 'wang_yi'],    // 张春华 + 王异
    ['zhu_rong_fu_ren', 'meng_huo'],  // 祝融夫人 + 孟获（用户写的是「祝融夫人+」，名字没写完，问过是孟获）
    ['zhu_rong_fu_ren', 'diao_chan'], // 祝融夫人 + 貂蝉
    ['sun_quan', 'lu_xun'],           // 孙权 + 陆逊
    ['zuo_ci', 'sun_jian2'],          // 左慈 + 群雄孙坚
    ['zhong_hui', 'jiang_wei'],       // 钟会 + 姜维
    ['zhu_ge_liang2', 'jiang_wei'],   // SP诸葛亮 + 姜维
    ['zhu_ge_liang2', 'ma_chao'],     // SP诸葛亮 + 马超
    ['huang_pu_song2', 'yuan_shu'],   // 皇甫嵩 + 袁术
    ['zhou_yu2', 'zhu_ge_liang'],     // SP周瑜 + 诸葛亮（**普通的**那个，不是 SP；2026-10-22 从 T1 升上来）
  ]),
  ...tierPairs(1, [   // —— T1（8 组）——
    ['zuo_ci', 'lu_xun'],             // 左慈 + 陆逊（2026-10-17 用户补的）
    ['zuo_ci', 'zhang_ning'],         // 左慈 + 张宁
    ['le_jin', 'zhang_liao'],         // 乐进 + 张辽
    ['yuan_shao', 'jiang_wei'],       // 袁绍 + 姜维
    ['yuan_shao', 'ma_chao'],         // 袁绍 + 马超
    ['hao_zhao', 'si_ma_yi'],         // 郝昭 + 司马懿
    ['zhao_yun', 'gan_fu_ren'],       // 赵云 + 甘夫人
    ['zhao_yun', 'liu_chan'],         // 赵云 + 刘禅
  ]),
  ...tierPairs(2, [   // —— T2（4 组）——
    ['guo_jia', 'xun_you'],           // 郭嘉 + 荀攸
    ['zhang_fei', 'wei_yan'],         // 张飞 + 魏延
    ['le_jin', 'wang_shuang'],        // 乐进 + 王双
    ['ma_teng', 'ma_yun_lu'],         // 马腾 + 马云禄
  ]),
];

// ★ 三人搭配（2026-10-22 用户加的）：乐进 + 马腾 + **任意一个**追击武将。
// 用户定的口径：这组和一条双人搭配**同权**，只算 **1 组 T1** —— 单独出现时
// 按现有规则仍落 T3，要再凑一组 T1（或 T0）才升上去。
// core 两个人必须都在**同一支部队**里；any 里至少有一个也在。
// 一组只记一次：不管 any 里同时命中几个人，都只算这一组。
db.LINEUP_TRIPLES = [
  {
    tier: 1,
    core: ['le_jin', 'ma_teng'],      // 乐进 + 马腾
    any: [
      'ma_yun_lu',                    // 马云禄
      'lv_bu',                        // 吕布
      'wang_shuang',                  // 王双
      'zhang_liao',                   // 张辽
      'xia_hou_yuan',                 // 夏侯渊
    ],
  },
];

// 一套阵容的评级（用户 2026-10-16 定的规则，从高往低依次判，命中一条就停）：
//   T0 ← 2 组 T0 搭配，或 3 组 T1
//   T1 ← T0 和 T1 都有，或 2 组 T1，或 3 组 T2
//   T2 ← 1 组 T0，或 T1 和 T2 都有
//   T3 ← 其余（默认档）
// 「搭配」既可以是双人的（LINEUP_PAIRS），也可以是三人的（LINEUP_TRIPLES），
// 每组都按它表里标的 tier 记一次 —— 三人组不因为多一个人就多算。
// 入参是**能改这张卡的人看到的那份武将表**（db.getSeasonHeroData 的 confirmed，
// 每项带 key / slot / name / variant / auto）。返回 { tier: 'T0'..'T3', pairs: [...] }，
// pairs 是命中的搭配（模板拿去当 title，让人看得见"凭什么给这个级"）。
// ⚠️ 只认**同一支部队**（slot 1-3 = 部队一，4-6 = 二，7-9 = 三）里的搭配。
db.lineupTier = (heroes) => {
  const units = new Map();               // 部队号 → 这支部队里的 key
  const label = new Map();               // key → 显示名（拼 title 用）
  for (const h of heroes || []) {
    if (!h || !h.key || !h.slot) continue;
    label.set(h.key, (h.variant || '') + h.name);
    const u = Math.floor((h.slot - 1) / 3);
    if (!units.has(u)) units.set(u, new Set());
    units.get(u).add(h.key);
  }
  const hits = [[], [], []];             // tier 0/1/2 各命中了几组
  for (const p of db.LINEUP_PAIRS) {
    for (const keys of units.values()) {
      // 两人都在这一支部队里才算 —— 同一个 key 在一套阵容里只可能出现一次，
      // 所以一组搭配最多命中一支部队，命中了就跳出，不用继续找。
      if (keys.has(p.a) && keys.has(p.b)) {
        hits[p.tier].push(`${label.get(p.a)} + ${label.get(p.b)}`);
        break;
      }
    }
  }
  // 三人搭配：core 全在、any 至少一个在，就算一组（tier 由表里给）。
  // 同样必须是**同一支部队**；any 里同时命中几个人也只记一次。
  for (const t of db.LINEUP_TRIPLES) {
    for (const keys of units.values()) {
      if (!t.core.every((k) => keys.has(k))) continue;
      const pick = t.any.find((k) => keys.has(k));
      if (!pick) continue;
      hits[t.tier].push(`${t.core.map((k) => label.get(k)).join(' + ')} + ${label.get(pick)}`);
      break;
    }
  }
  const n = hits.map((list) => list.length);
  const tier = (n[0] >= 2 || n[1] >= 3) ? 'T0'
    : ((n[0] && n[1]) || n[1] >= 2 || n[2] >= 3) ? 'T1'
      : (n[0] || (n[1] && n[2])) ? 'T2' : 'T3';
  return { tier, pairs: [...hits[0], ...hits[1], ...hits[2]] };
};

// 识别效果的统计（/admin 的「阵容识别」块）。用户要的"整理反思、定期修复"就落在这儿。
//
// ⚠️ 2026-10-16 改过一次口径，**改的原因是旧口径在自我美化**：
//   旧版的分母是「玩家选了候选的格子」，而"手输"那一整类根本不进分母 ——
//   偏偏手输正是机器错得最狠的地方。于是页面显示 89%/100%，真值是 65%/73%。
//
// 现在的口径按"人核对过没有"切分，这是唯一诚实的切法：
//   · 机器填的（filled）—— 其中高/低置信。**这一档是工作量，不是质量**：
//     没人核对过的格子既不算对也不算错，放进准确率的分母只会让数字随"玩家懒得点"虚高。
//   · 人核对过的（reviewed）—— 才有资格谈对错。准确率 = 机器对 / (机器对 + 被改掉)。
//     分母**不含**"机器原本空着、人补上的"：那是漏（召回），不是错（精度）。
//   · 纠正排行（pairs）—— 「机器说 X → 玩家改成 Y」。**这就是"定期总结修复"的入口**：
//     高频配对要么是 herodata 里的错画（皮肤版本对不上，用户已确认存在），
//     要么是两个长得像的武将。照着这份名单修，比重新跑一遍分析便宜得多。
db.getRecoStats = () => {
  const rows = db.prepare(`
    SELECT auto_key, confidence, chosen_key, other_name, decided_at, candidates, ocr
    FROM hero_guesses`).all();

  const s = { total: rows.length, filled: 0, high: 0, low: 0,
              reviewed: 0, kept: 0, corrected: 0, added: 0, cleared: 0,
              // 两路各自的准确率。合并后的数字看不出"是哪一路在干活" ——
              // 这一栏是调参/换模型的依据（2026-10-17 起视觉模型那一路已移除）。
              paths: { ncc: { answered: 0, right: 0 },
                       ocr: { answered: 0, right: 0 } } };
  const pairs = new Map();
  const unresolved = [];
  const topKey = (json) => {
    try { const a = JSON.parse(json || '[]'); return a[0] ? a[0].key : null; } catch { return null; }
  };

  for (const r of rows) {
    if (r.auto_key) {
      s.filled++;
      if (r.confidence === 'high') s.high++; else s.low++;
    }
    if (r.decided_at) {
      s.reviewed++;
      if (r.auto_key === null || r.auto_key === undefined) {
        if (r.chosen_key) s.added++; else s.cleared++;
      } else if (r.chosen_key === r.auto_key) {
        s.kept++;                                  // 机器填的，人看了没动 —— 机器对
      } else {
        s.corrected++;                             // 被改掉了 —— 机器错
        const k = `${r.auto_key}→${r.chosen_key || '__none__'}`;
        pairs.set(k, (pairs.get(k) || 0) + 1);
      }
    }
    // 玩家手输了、但对不上库里任何一个武将：要么库里漏了这个武将，要么他打错了字。
    // ⚠️ 这已经是**历史数据的考古层**了：2026-10-16 晚起服务端不再收对不上的名字
    //    （见 routes/main.js），所以这个数组只会越来越旧、不会长。留着是因为
    //    "库里漏了哪个武将"这件事仍然值得回头看一眼 —— 名单本身已经集齐了。
    if (!r.chosen_key && r.other_name) unresolved.push(r.other_name);

    // 两路各自的准不准。分母口径：**人核对过、而且给出了明确名字**的格子 ——
    // 只有这种格子才有"真值"可比；「人判不确定」和"没人看过"都不该进分母
    // （和上面 kept/corrected 的切法是同一套理由，见函数头）。
    // 注意一条路的"有输出"不等于"自动填的用的是它" —— 这里量的是每路自己的判断力。
    if (r.decided_at && r.chosen_key) {
      for (const [name, col] of [['ncc', 'candidates'], ['ocr', 'ocr']]) {
        const k = topKey(r[col]);
        if (!k) continue;
        s.paths[name].answered++;
        if (k === r.chosen_key) s.paths[name].right++;
      }
    }
  }

  // 纠正排行翻成显示名。库里已经查不到的 key 就原样显示 —— 那本身也是条线索。
  const label = (key) => {
    if (key === '__none__') return '（玩家说没有）';
    const h = key ? db.getHero(key) : null;
    return h ? (h.variant || '') + h.name : `?${key}`;
  };
  s.pairs = [...pairs.entries()]
    .map(([k, n]) => { const [from, to] = k.split('→'); return { from: label(from), to: label(to), n }; })
    .sort((a, b) => b.n - a.n)
    .slice(0, 20);

  s.unresolved = unresolved;
  return s;
};

// 阵容墙上用的批量版。**必须批量** —— 一面墙十几张卡，逐张查就是 N+1。
// 而且候选 JSON 那一列很大（一张图 9 格 × 3 个候选），全查回来能撑到 100KB，
// 所以只给**能改这张卡的人**（本人 / 管理员）查。
db.getSeasonHeroData = (seasonId, editableEntryIds) => {
  const confirmed = new Map();
  // 从 2026-10-16 起这一份**不只是"玩家确认过的"了**：机器自动填的也在里面
  // （用户定的是"含机器填的对所有人可见，标出是机器填的"）。
  // 靠 source 分辨：'auto' = 机器填的、还没人核对过 → 卡上打「待核对」标记。
  // ★ 只认**卡上摊开的那张图**（第一张，按 id）。为什么必须写死这一条：
  //   老数据里一个 entry 可能有两张阵容图（两套不同的阵容），从前这里有 entry 就收，
  //   于是那三张卡的武将行是**两张图拼起来**的。评级要数"同一支部队里的两个人"，
  //   拼起来数就是把两套阵容的部队搅在一块儿 —— 必然算出个假的 T0。
  //   面板那边（下面的 guesses）本来就是按 filename 查的，现在两边口径一致了。
  const rows = db.prepare(`
    SELECT g.entry_id, g.slot, g.source, h.key, h.name, h.faction, h.arm, h.variant
    FROM hero_guesses g JOIN heroes h ON h.key = g.chosen_key
    JOIN entries e ON e.id = g.entry_id
    WHERE e.season_id = ?
      AND g.filename = (SELECT li.filename FROM lineup_images li
                        WHERE li.entry_id = g.entry_id AND li.is_preliminary = 0
                        ORDER BY li.id LIMIT 1)
    ORDER BY h.sort`).all(seasonId);
  for (const r of rows) {
    if (!confirmed.has(r.entry_id)) confirmed.set(r.entry_id, []);
    const list = confirmed.get(r.entry_id);
    const auto = r.source === 'auto';
    // 同一张图的 9 格里不该出现同一个武将，但历史数据可能有 —— 去重。
    // 重复时**人工的那条赢**：不能因为机器也猜了这个武将，就把人核对过的标记冲掉。
    const hit = list.find((h) => h.key === r.key);
    if (hit) { if (!auto) hit.auto = false; continue; }
    // `slot` 是给**评级**用的（db.lineupTier 要按部队分组：1-3 / 4-6 / 7-9）
    list.push({ key: r.key, name: r.name, faction: r.faction, arm: r.arm,
                variant: r.variant, slot: r.slot, auto });
  }

  const guesses = new Map();
  if (editableEntryIds && editableEntryIds.length) {
    const ph = editableEntryIds.map(() => '?').join(',');
    const gs = db.prepare(`
      SELECT * FROM hero_guesses WHERE entry_id IN (${ph}) ORDER BY entry_id, slot`).all(...editableEntryIds);
    for (const g of gs) {
      if (!guesses.has(g.entry_id)) guesses.set(g.entry_id, []);
      let cands = [];
      try { cands = JSON.parse(g.candidates); } catch { cands = []; }
      // ★ 把**玩家确认的那个武将**一并带出来。
      //   为什么必须带：他点的很可能是「其他」手输的、或者一个不在候选里的武将
      //   （候选本来就常常认错）。不带的话，界面上没有任何单选框是选中的 ——
      //   玩家的确认**在页面上看不见**，看起来像是没存上。
      const chosen = g.chosen_key ? db.getHero(g.chosen_key) : null;
      guesses.get(g.entry_id).push({ ...g, candidates: cands, chosen });
    }
  }
  return { confirmed, guesses };
};

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

// 「前两名」—— 2026-10-15 起本站三处用到这个数，而且**必须是同一个数**，
// 所以只有这一个真源（改规矩只改这一行）：
//   · 结算时谁算赢（settleSeason 写 is_winner）—— 用户定的：积分前两名都算胜利；
//   · 结算时给谁打的票能涨慧眼等级（applyEye）；
//   · 阵容墙上给上一期的前两名描边，亮蓝 / 亮银（getPrevAces）。
// 三件事都是"积分前两名"这同一个概念，故意绑在一起；哪天要拆（比如"前 3 名都算赢、
// 但慧眼还是只看前 2"），把这个常数拆成两个，别在调用处各写一个字面量 2。
const TOP_N = 2;
db.TOP_N = TOP_N;

// 上一期的积分第一 / 第二是谁 —— 阵容墙给他们的卡描边（亮蓝 / 亮银）。
// 「上一期」= 这一期之前**最近一个已结算的期**；没有就返回空表
// （第一期，或者上一期还没结算 —— 这两种情况下墙上一条边都不描）。
// 名次取 final_rank：它是结算时定死的，之后改不了（已结算期不允许改积分，见 routes/admin.js）。
db.getPrevAces = (seasonId) => {
  const aces = new Map();                                    // users.id → 1 | 2
  const prev = db.prepare(
    `SELECT id FROM seasons WHERE id < ? AND status='settled' ORDER BY id DESC LIMIT 1`).get(seasonId);
  if (!prev) return aces;
  db.getFinalRanking(prev.id).slice(0, TOP_N).forEach((row, i) => aces.set(row.user_id, i + 1));
  return aces;
};

// 本期阵容墙：所有传了阵容的人，**不限于交了积分的**。
// 只看 ranking 是不够的 —— 新开一期时常常是「有人传了阵容但还没人交积分」，
// 那样墙会是空的。
// 展示顺序分两段（2026-10-17 用户定的规矩，真源是下面的 db.isWallByScore）：
//   · 打分截止（每期开期后第一个周四 12:00 北京）**之前**：互评均分从高到低，
//     「哪套阵容公认最好」—— 这也是打分窗口里大家投票时想看的东西；
//   · 截止**之后**（以及已结算的期）：积分从高到低。到点了名次基本明朗，
//     打分也封盘了，墙跟着排名走。
// 上面那条 SQL 本来就是积分序（分数降序 → 同分先提交 → id），所以后半段直接照它排；
// 前半段才在 JS 里按均分重排。
// rank 无论哪一段都按积分序算（见下），所以卡上的 #N 始终是**积分名次**，和排名表对得上。
// lineup_note 也一起带出来：墙上除了第一张图还要展示阵容说明（模板里按行截断，
// 卡片只有 200px 宽，1000 字的说明全摊开会把整行卡片顶得老高）。
// viewerId 用来认出「我给他打了多少」，卡上要把这一档标出来（别人打的不用管）。
// ace 是「上一期的积分第一/第二」（1 / 2），模板据此给卡描亮蓝/亮银边；其余人是 null。
//
// freezeIds 是**可选**的第三参：一串 entry id，来自"上一次渲染这面墙时的顺序"。
// 只有一处会传它 —— 首页那条 GET / 在"刚从打分 POST 跳回来"的那一次（见 routes/main.js）。
// 用户 2026-10-14 的口径是「打分以后不动，刷新网页再重排」：投一票会改均分、均分决定顺序，
// 整页重刷回来的那份顺序要是变了，人正在看的卡片当场跳走、还得重新找。所以那一跳照原样排，
// 用户自己刷新时（session 里的标记已经用掉）自然就按最新的顺序重排了。
// ⚠️ 默认顺序（下面那段）被三处共享：`/wall`（routes/public.js）、结算战报
// （routes/main.js 的 buildReport）和首页 —— 冻结只是首页那一次的特例。
// （冻结只可能发生在打分窗口里 —— 封盘后投不出票，所以 byScore 那段永远轮不到 freezeIds。）
db.getLineupWall = (seasonId, viewerId, freezeIds, isAdmin) => {
  const season = db.getSeason(seasonId);
  const byScore = db.isWallByScore(season);

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
  // 第三个参数是「现在戴着慧眼王的那些人」：卡片打分区要多印一行他们给的分
  // （2026-10-19）。一次查询给整面墙用，别按卡去查。
  const ratings = db.summarizeRatings(
    db.getSeasonRatings(seasonId), viewerId, db.getHuiyanHolders().uids);
  // 评论同理，一次查回来挂到卡上。挂在这一层（而不是让 / 和 /wall 各自去查）
  // 是为了两侧永远一致：首页的墙和游客的墙引的是同一份 rows。
  const comments = db.getWallComments(seasonId);

  // 只有交了积分的才有名次；没交的排最后且 rank 为 null。
  // rank 按上面那条 SQL 的顺序（= 积分序）数出来，所以它始终是积分名次，
  // 和下面重排展示顺序无关。
  // ace 取的是**上一期**的名次（跨期查，见 getPrevAces），和本期的 rank 没有任何关系：
  // 一个是"你上期第几"（决定边框），一个是"你这期第几"（决定 #N）。
  const aces = db.getPrevAces(seasonId);

  // 阵容识别结果（2026-10-16）。同样一次查回来挂到卡上。
  // 能改这张卡的人 = 本人或管理员 —— 只有他们才需要看到候选 JSON（见 db.getSeasonHeroData）。
  // ⚠️ `heroes` 这一列从此每项都带 `slot`（评级要按部队分组）且**只含卡上那张图**的
  //    （老数据里一个 entry 可能有两张图，见 getSeasonHeroData 里那段）。
  const editable = rows.filter((r) => r.user_id === viewerId || isAdmin).map((r) => r.id);
  const heroData = db.getSeasonHeroData(seasonId, editable);

  let rank = 0;
  const wall = rows.map((r) => ({
    ...r,
    rank: r.score === null ? null : ++rank,
    ace: aces.get(r.user_id) || null,
    images: db.getLineupImages(r.id),
    rating: ratings.get(r.id) || db.EMPTY_RATING,
    comments: comments.get(r.id) || [],
    // 认出来的武将（所有人可见，T0 高亮要用）。**从 2026-10-16 起机器自动填的也在里面**，
    // 靠每项上的 `auto` 布尔区分 —— 模板据此画虚框 + 打「待核对」，见 reco.ejs。
    heroes: heroData.confirmed.get(r.id) || [],
    // 候选（只对能改这张卡的人有值，别人是空数组）
    guesses: heroData.guesses.get(r.id) || [],
  }));

  // 默认顺序（见函数头）：
  //   · 打分截止前 → 互评均分高的在前。没人打分的 avg 是 null，一律沉底。
  //     均分相同的保持前面的积分序（sort 稳定），等于回落到「积分高者在前」，
  //     不再另立一套同分规则。
  //   · 打分截止后 / 已结算 → 保持上面那条 SQL 的顺序（积分降序 → 同分先提交 → id）。
  //     不用再排一遍；没交积分的本来就被 SQL 的 `score IS NULL` 垫底。
  const avgOf = (r) => (r.rating.avg === null ? -1 : r.rating.avg);
  const sorted = byScore ? wall : wall.sort((a, b) => avgOf(b) - avgOf(a));

  // 上面那套是默认顺序。freezeIds 只被"刚投完票跳回来的那一次"用到（见函数头的注释）。
  // isAdmin 只影响"阵容识别的候选要不要一起查回来"（见上面 editable 那行）。
  if (!freezeIds || !freezeIds.length) return sorted;

  // 「冻结」= 名单里的行按那份顺序提到前面，其余（这一版新传的卡、或者认不出来的 id）
  // 保持默认顺序跟在后面。
  // ⚠️ 落到名单外的哨兵要写 `freezeIds.length` 这个**有限的数**，不能写 Infinity：
  // 两个都在名单外时 `Infinity - Infinity` 是 NaN，比较函数返回 NaN 的行为由引擎定，
  // 那一段的顺序就成了随机的。
  const pos = new Map(freezeIds.map((id, i) => [id, i]));
  const rankOf = (r) => (pos.has(r.id) ? pos.get(r.id) : freezeIds.length);
  return sorted.sort((a, b) => rankOf(a) - rankOf(b));
};

// 还没交积分的启用成员（R12：被禁用的不列出）。
// `lineup_uploaded` 只认**完整**阵容图；`lineup_any` 是"有任何图"（含初步图）。
// 两个分开报，页面上才能把"已传阵容"和"只传了初步图"说清楚。
db.getNotSubmitted = (seasonId) => db.prepare(`
  SELECT u.user_id AS uid, u.nickname, e.id AS entry_id, e.lineup_note,
         EXISTS (SELECT 1 FROM lineup_images li
                 WHERE li.entry_id = e.id AND li.is_preliminary = 0) AS lineup_uploaded,
         EXISTS (SELECT 1 FROM lineup_images li WHERE li.entry_id = e.id) AS lineup_any
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

// 开期之后**严格晚于** created_at 的第一个「星期 weekday 的北京 12:00」，返回毫秒时间戳。
//
// 「严格晚于」是关键：万一正好卡在那一刻开期，算下一周 —— 否则那一期一开出来
// 就已经过了自己的截止点。下面两个时刻共用这一段，只差一个 weekday。
function nextNoonBJ(created, weekday) {
  // 把"北京墙上时间"借 UTC 的字段读出来：created + 8h 之后，getUTC* 拿到的就是北京的日期
  const d = new Date(created + BJ_OFFSET_MS);
  // 12:00 北京 = 04:00 UTC，所以拿日期直接凑出当天那个时刻，再一天天往后找
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), LOCK_HOUR_BJ - 8);
  for (let i = 0; i < 8; i++) {           // 最多往后 7 天，必中
    if (t > created && new Date(t + BJ_OFFSET_MS).getUTCDay() === weekday) break;
    t += 86400000;
  }
  return t;
}

const parseCreated = (season) => {
  const t = Date.parse(season?.created_at ?? '');
  return Number.isFinite(t) ? t : null;
};

// 这一期的打分截止时刻，没有有效的 created_at 就返回 null。
db.getRateLockAt = (season) => {
  const created = parseCreated(season);
  return created === null ? null : nextNoonBJ(created, LOCK_WEEKDAY);
};

// 这一期封盘了没有。**只看时间**，不看 status：已结算的期由别处挡着
// （结算后连打分区都不出），这里管的是"还开着、但已经过了周四 12:00"。
db.isRateLocked = (season) => {
  const at = db.getRateLockAt(season);
  return at !== null && Date.now() >= at;
};

// 阵容墙此刻按什么排（2026-10-17 用户定的规矩）。
// true = 按积分降序；false = 按互评均分降序。
//   · 打分截止（上面的周四 12:00）之后 → 按积分。到点了名次基本明朗，墙跟着排名走；
//   · 还没截止 → 按均分。这正是大家还在投票的窗口，墙想看的是「公认最好」；
//   · 已结算的期 → 一律按积分，不看时间：结算必然在封盘之后，而且名次已经定死。
// getLineupWall 用它决定数据顺序，路由用它决定墙上那句说明怎么写 —— 同一个真源，
// 两边才不会一个按积分排、一个写着"按均分"。
db.isWallByScore = (season) => !!season && (season.status === 'settled' || db.isRateLocked(season));

// ---------- 阵容上传的窗口（2026-10-16 加，2026-10-18 改口径）----------
//
// 现行规矩（用户 2026-10-18 定的）分两段：
//   ① **周二 12:00 起**可以上传「初步阵容图」—— 只作展示：**不做识别、不计入任何武将数据**，
//      也**不算参赛**（参赛仍然要有完整阵容图或积分，见下面的 STATS_SQL）；
//      从此时刻起也就可以打分了（打分本来就没有单独的开放时刻：有图可看就能投）。
//   ② **周三 12:00 起**是「完整阵容图」窗口 —— 这时再传一张，会**覆盖**之前那张初步图
//      （连同 R2 上的对象一起删掉，见 routes/main.js 的 POST /lineup）。
//      完整图才进识别队列、才进武将统计。
//
// 三段共用 nextNoonBJ，只差一个 weekday —— 别抄第二份算法。
//
// ⚠️ 这里有个和打分一模一样的坑，`/admin` 必须把算出来的时刻摆给管理员看：
//    **周三 12:00 之后开期的话，两个时刻都会顺延到下周** —— 等于整整一周谁都不能
//    传阵容。开期前就能看见，比开完才发现强。
const OPEN_WEEKDAY = 2;                   // 2 = 周二：初步阵容窗口打开（同时可以打分）
const FULL_WEEKDAY = 3;                   // 3 = 周三：完整阵容窗口打开

db.getUploadOpenAt = (season) => {
  const created = parseCreated(season);
  return created === null ? null : nextNoonBJ(created, OPEN_WEEKDAY);
};

// 完整阵容图从这一刻起可以传（同时意味着"初步图已经可以覆盖了"）。
db.getFullUploadAt = (season) => {
  const created = parseCreated(season);
  return created === null ? null : nextNoonBJ(created, FULL_WEEKDAY);
};

// 上传窗口还没开。**只按时间判**，不看 status —— 和 isRateLocked 同一个道理：
// 已结算的期由调用方（当前的期才渲染 /lineup）挡着。
db.isLineupClosed = (season) => {
  const at = db.getUploadOpenAt(season);
  return at !== null && Date.now() < at;
};

// 现在这一期处在哪个上传阶段。路由 / 模板 / 签发令牌**都读这一个函数**，
// 免得一处按周二判、另一处还写着周三。
//   · 'closed'      —— 还没到周二 12:00，谁都不能传；
//   · 'preliminary' —— 周二 12:00 到周三 12:00：只能传初步图（只展示、不识别、不进数据）；
//   · 'full'        —— 周三 12:00 之后：传的是完整图，会覆盖掉那张初步图。
// created_at 无效（null）时按 'closed' 处理：宁可不让人传，也不要造出没有时间依据的图。
db.getUploadPhase = (season) => {
  const open = db.getUploadOpenAt(season);
  if (open === null) return 'closed';
  const now = Date.now();
  if (now < open) return 'closed';
  const full = db.getFullUploadAt(season);
  return full !== null && now < full ? 'preliminary' : 'full';
};

// 没人打过分时的形状。模板直接读，不用到处判空；冻结只是提醒别改它。
// huiyan 是 2026-10-19 加的「慧眼王给这套阵容打的分」（见 summarizeRatings）。
db.EMPTY_RATING = Object.freeze({
  n: 0, avg: null, max: null, min: null, maxBy: [], minBy: [], mine: null, huiyan: null,
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
// r.id 只给「慧眼王评分」那一行做同一毫秒的兜底排序用（见 summarizeRatings）：
// created_at 精度是毫秒，测试夹具和并发投票都可能撞在同一毫秒上。
db.getSeasonRatings = (seasonId) => db.prepare(`
  SELECT r.id, r.entry_id, r.rater_id, r.value, r.created_at,
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

// 把某一期的打分**整批**清掉，返回删掉的条数（`/admin` 那个「清空本期全部打分」用）。
// 和上面逐条删是同一件事，只是范围不同：名额是现数的（见 getMyQuota），
// 所以删完所有人的名额当场满血，不用动别的表。
// ratings 里没存 season_id，期由 entry 带出来（见 schema.sql），于是走一个子查询圈定范围。
// 一条 DELETE 本身就是原子的，不用再包事务。
db.clearSeasonRatings = (seasonId) => db.prepare(`
  DELETE FROM ratings
  WHERE entry_id IN (SELECT id FROM entries WHERE season_id = ?)
`).run(seasonId).changes;

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
// summary = { n, avg, max, min, maxBy, minBy, mine, huiyan }
// maxBy / minBy 把**并列的人全给**、一个都不截（顺序 = 先给出这个分的人在前）：
// 只有五档，并列太常见，而"这一分是谁先给的"只有这份数组说得清。
// 印到卡上是另一回事 —— **只印第一个**，见 views/partials/name-list.ejs。
//
// huiyan（2026-10-19 加的）是「慧眼王给这套阵容打的分」，卡片打分区多印的那一行。
// huiyanUids 是**当前**戴着慧眼王称号的那批人（小写 uid 的 Set，来自 getHuiyanHolders，
// 和卡顶那枚王冠同一个真源 —— 称号不落库，这里也不给它另立一套判定）。
// **多个慧眼王都给这套阵容投过票时只留最先打分的那一个**（created_at 最早、同毫秒按
// rating id）：用户定的展示口径和「最高/最低」只印并列第一人一样 —— 卡片只有 200px 宽，
// 一行放不下第二个名字。不传 huiyanUids 时 huiyan 一律为 null（称号是"全站第一"，
// 不知道谁戴着就没什么可挑的）。
db.summarizeRatings = (rows, viewerId, huiyanUids = null) => {
  const byEntry = new Map();

  for (const r of rows) {
    let s = byEntry.get(r.entry_id);
    if (!s) {
      s = { n: 0, sum: 0, max: -Infinity, min: Infinity, maxBy: [], minBy: [], mine: null, huiyan: null };
      byEntry.set(r.entry_id, s);
    }
    s.n++;
    s.sum += r.value;

    const who = { uid: r.uid, nickname: r.nickname };
    if (r.value > s.max) { s.max = r.value; s.maxBy = [who]; }
    else if (r.value === s.max) s.maxBy.push(who);
    if (r.value < s.min) { s.min = r.value; s.minBy = [who]; }
    else if (r.value === s.min) s.minBy.push(who);

    // 慧眼王那一行：只留最早的那一票。行是按「分数降序、时间升序」来的，不能靠先后判断。
    if (huiyanUids && huiyanUids.has(String(r.uid).toLowerCase())) {
      const prev = s.huiyan;
      if (!prev || r.created_at < prev.created_at
          || (r.created_at === prev.created_at && r.id < prev.id)) {
        s.huiyan = { uid: r.uid, nickname: r.nickname, value: r.value,
                     created_at: r.created_at, id: r.id };
      }
    }

    if (r.rater_id === viewerId) s.mine = r.value;   // UNIQUE 保证最多一条
  }

  for (const s of byEntry.values()) {
    s.avg = Math.round((s.sum / s.n) * 10) / 10;   // 保留 1 位；整数时 JS 直接打印成 250
    delete s.sum;
    // 排序用的两个字段不往模板送：卡片上只要 uid / 昵称 / 分数。
    if (s.huiyan) {
      delete s.huiyan.created_at;
      delete s.huiyan.id;
    }
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

// ★ 评论功能总开关。**2026-10-17 用户要求「暂时屏蔽评论功能」，所以这里是 false**；
//   改回 true 就原样恢复 —— 不迁移、不动库、已有的留言一条不删。
//   关着的时候三件事一起发生（都读这一个常量，别在别处再写一份开关）：
//     · 阵容卡不再渲染评论区（partials/lineup-gallery.ejs 的 include，经 res.locals）；
//     · 页脚不再引 comments.js（partials/footer.ejs）；
//     · 两条 POST（发表 / 删除）直接挡回，见 routes/public.js —— 挡的是
//       浏览器缓存里的旧页面和手搓请求，不是靠"藏起按钮"假装没有这个接口。
db.COMMENTS_ENABLED = false;

// ---------- 评论（阵容卡下面的短留言，每条 ≤20 字） ----------
// 一期一次全查回来、在 JS 里按 entry_id 归并，和打分那边（getSeasonRatings →
// summarizeRatings）是同一个套路：留言是「人数 × 阵容数」，量级很小，
// 不值得为它写一堆 GROUP BY、再逐个回查留言人。
// **LEFT JOIN users**：游客那一行压根没有 user，JOIN 出来是 NULL ——
// 库里存的是事实（没有这个人），显示成「游客」是模板的事，不在这层编字符串。
// 返回 Map<entry_id, [{ id, body, created_at, uid, nickname, is_guest }]>，老留言在前。
db.getWallComments = (seasonId) => {
  const rows = db.prepare(`
    SELECT c.id, c.entry_id, c.body, c.created_at, c.user_id,
           u.user_id AS uid, u.nickname
    FROM comments c
    JOIN entries e ON e.id = c.entry_id
    LEFT JOIN users u ON u.id = c.user_id
    WHERE e.season_id = ?
    ORDER BY c.created_at ASC, c.id ASC
  `).all(seasonId);

  const byEntry = new Map();
  for (const r of rows) {
    if (!byEntry.has(r.entry_id)) byEntry.set(r.entry_id, []);
    byEntry.get(r.entry_id).push({
      id: r.id,
      body: r.body,
      created_at: r.created_at,
      uid: r.uid,
      nickname: r.nickname,
      // user_id 也带上：模板要靠它判「这条是不是我发的」（能不能删）。
      // 别拿昵称去比 —— 昵称是成员自己填的，可以重名。
      user_id: r.user_id,
      // 「这条是不是游客发的」的判据只放这一处，别让每个模板各自去比 null
      is_guest: r.user_id === null,
    });
  }
  return byEntry;
};

// 发表。userId 传 null 就是游客（发布的人没登录）。20 字的上限在路由里管，这儿不重复校验。
db.addComment = (entryId, userId, body) => db.prepare(
  `INSERT INTO comments (entry_id, user_id, body) VALUES (?, ?, ?)`
).run(entryId, userId ?? null, body).lastInsertRowid;

db.getComment = (id) => db.prepare(`SELECT * FROM comments WHERE id=?`).get(id);

db.deleteComment = (id) => db.prepare(`DELETE FROM comments WHERE id=?`).run(id).changes;

// 这个文件名是不是一张阵容图。
// 从前它是给 app.js 的 canSeeUpload 用的（游客取 /uploads 下的图时逐个放行），
// 那套白名单随"图片全公开"一起删了。现在改给 routes/main.js 的提交用：
// **同一张图不该被引用两次**（见下面的 isImageInUse）。走 idx_lineup_filename。
db.isLineupImage = (filename) => !!db.prepare(
  `SELECT 1 FROM lineup_images WHERE filename=?`
).get(filename);

// 这个文件名有没有被**任何地方**引用（阵容图 或 积分截图）。
// 提交阵容时用它跳过"已经在用的" —— 只看 lineup_images 不够：一个人完全可以拿自己
// 积分截图的那张 key 再当阵容图提交（令牌是通用的、不做用途区分），那样删掉阵容那一行
// 就会把他的积分截图一起删掉。要防的就是这种事。
db.isImageInUse = (filename) => !!db.prepare(
  `SELECT 1 FROM lineup_images WHERE filename=?
   UNION ALL
   SELECT 1 FROM entries WHERE score_image=?
   LIMIT 1`
).get(filename, filename);

// ---------- 统计（只算已结算的期；**参赛 = 上传了阵容或交了积分**） ----------
// 一期内一人一行（entries 的 UNIQUE(season_id, user_id)），所以 COUNT(*) 就是"参过几期"。
// 2026-10-15 起"参赛"不再要求交积分：传了阵容就算参了这一期，于是没交分的人也会进榜
// （胜场 0、胜率 0%），胜率的分母也从"交过分的期数"变成"到过场的期数"。
// 分数那三列照旧只认交过分的行：AVG / MAX 天然跳过 NULL，MIN(final_rank) 也是。
// 只传阵容、一场没交分的人这三列全是 NULL，模板印成「—」。
// ★ 2026-10-18 起 **初步阵容图不算参赛**（`li.is_preliminary = 0`）：那张图只作展示，
//   用户的原话是"不纳入数据"。没换完整图就等于没真正到场，不该进胜率分母。
const STATS_SQL = `
  SELECT u.user_id AS uid, u.nickname,
         u.created_at                                   AS joined_at,
         SUM(e.is_winner)                               AS wins,
         COUNT(*)                                       AS plays,
         ROUND(100.0 * SUM(e.is_winner) / COUNT(*), 1)  AS win_rate,
         ROUND(AVG(e.score), 1)                         AS avg_score,
         MAX(e.score)                                   AS best_score,
         MIN(e.final_rank)                              AS best_rank
  FROM entries e
  JOIN seasons s ON s.id = e.season_id AND s.status = 'settled'
  JOIN users   u ON u.id = e.user_id
  WHERE (e.score IS NOT NULL
         OR EXISTS (SELECT 1 FROM lineup_images li
                    WHERE li.entry_id = e.id AND li.is_preliminary = 0))`;
// ⚠️ 上面那个 WHERE 的括号不能省：getUserStats 会往后面接 `AND u.id = ?`，
// 少了括号就是 `A OR (B AND u.id=?)`，一查个人页会把**全站**交过分的人一起捞出来。

// 排序（用户定的口径，2026-10-16 加第三条）：**先比胜场，再比胜率，再比平均分，
// 三样都一样时先加入的在前**。
//   · 第三条本来是个 `plays DESC`（2026-10-15 拿掉）：它其实**几乎从不生效** —— 胜场相同时
//     "胜率也一样"基本就意味着场次一样（胜率 = 胜场 / 场次），只有四舍五入到同一位小数时
//     才轮得到它。留着只会让人以为"多打几场"是个优势。
//   · 平均分 = 交过分的期里的平均（`AVG(e.score)` 天然跳过 NULL），**就是页面上那一列**，
//     所以"按平均分排"和眼睛看到的一致。只传阵容、一场没交分的人这一列是空的，
//     `DESC` 在 SQLite 里把 NULL 排在最后（NULL 比任何值都小），正好是"没分的人垫底"。
//     它只决定并列的人之间谁在前（以及那枚演武王章挂在谁身上），**不进称号的判据**。
//   · 时间取 users.created_at（注册/加入时间，个人页上印的"加入于"就是它）：
//     全库只有这一个每人一份的时间，先来后到也说得清。末尾的 u.id 只是兜底，
//     保证顺序**永远**是全序（同一毫秒注册的两个人不能靠引擎的脾气决定谁在上面）。
db.getRankBoard = () => db.prepare(`${STATS_SQL}
  GROUP BY u.id
  ORDER BY wins DESC, win_rate DESC, avg_score DESC, joined_at ASC, u.id ASC`).all();

db.getUserStats = (userPk) => db.prepare(`${STATS_SQL} AND u.id = ? GROUP BY u.id`).get(userPk);

// ---------- 称号（演武王 / 慧眼王） ----------
// 两枚称号**不落库**：它们是"现在谁是第一"的实时结论，存下来就得在结算、撤销结算、
// 删赛期、清票……每一条路径上记得同步改一遍，漏一条就会出现"榜上第一换了人、王冠还戴在
// 别人头上"。现算只要两条小查询（榜单 + 一眼 MAX），永远不会和 /rank 对不上。
//
//   演武王 —— 胜场最多的那批人里，胜率最高的（并列就一起封）。
//              口径就是 /rank 排序的前两项（wins DESC, win_rate DESC），所以**头名必定是
//              排行榜第一行**：不存在"只打过一期赢了就称王"（那样的人在排行榜上也不是第一）。
//              /rank 第一行那枚章印的就是这三个字（用户 2026-10-15 定的：从「头名」改名过来）。
//              两处口径相同、写法不同：榜单**只给第一行**挂章，墙上的称号章按"并列一起封"
//              —— 胜场和胜率都一样的人会各戴一枚，而排行榜第一行只有一位（时间先后定的）。
//   慧眼王 —— 慧眼等级最高的那批人（并列一起封），但**等级还全停在初始 10 级时不封**：
//              所有人都是 10 的时候严格按"同级都封"就是全员戴冠，等于没称号。
//              等第一次结算把谁顶上去，王冠自己就出现了。
//
// **不排除已禁用的成员**：胜场和等级都照 /rank 与 users 表原样算。称号一旦和榜单
// 分家（"排行榜第一"和"演武王"是两个人），就会有人拿着两个页面对不上。
//
// 返回 Map<uid（小写）, [{ key, label, tip }]>，key 只有 yanwu / huiyan 两种、顺序固定。
// uid 转小写是为了和 app.js 的 eyeLevel 一个口径，调用处不用记大小写。
const EYE_BASE = 10;                     // 初始等级，必须和 schema.sql 里 eye_level 的 DEFAULT 一致

// 现在戴着「慧眼王」的那批人：{ level: 最高等级, uids: Set<小写 uid> }。
// **判定只写这一处**，两个读它的人必须同一个口径：
//   · getTitles() —— 卡顶昵称前那枚亮蓝的章；
//   · summarizeRatings() —— 打分区新增的「慧眼王」那一行（2026-10-19）。
// 等级还全停在初始 10 级时 uids 是空集合（= 没王），和称号章的规矩一致：
// 所有人都 10 级时严格按"同级都封"就是全员戴冠，等于没称号。
db.getHuiyanHolders = () => {
  const level = db.prepare(`SELECT MAX(eye_level) AS lv FROM users`).get().lv;
  if (!(level > EYE_BASE)) return { level, uids: new Set() };
  return {
    level,
    uids: new Set(db.prepare(`SELECT user_id FROM users WHERE eye_level = ?`).all(level)
      .map((u) => String(u.user_id).toLowerCase())),
  };
};

db.getTitles = () => {
  const map = new Map();
  const add = (uid, title) => {
    const k = String(uid).toLowerCase();
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(title);
  };

  // 演武王。⚠️ 胜场为 0 时一个都不封：全站都没人赢过的时候"胜场最多"就是 0 胜，
  // 那批人的胜率也全是 0 —— 不拦的话所有没赢过的人当场都成了演武王。
  const board = db.getRankBoard();       // 已按 wins DESC, win_rate DESC, joined_at 排好
  if (board.length && board[0].wins > 0) {
    const topWins = board[0].wins;
    const best = Math.max(...board.filter((r) => r.wins === topWins).map((r) => r.win_rate));
    for (const r of board) {
      if (r.wins !== topWins || r.win_rate !== best) continue;
      add(r.uid, {
        key: 'yanwu',
        label: '演武王',
        tip: `演武王：胜场最多的人里胜率最高的（${r.wins} 胜 / ${r.plays} 场 · 胜率 ${r.win_rate}%）`,
      });
    }
  }

  // 慧眼王。只挑最高的那一档，并列的全给（判定在 getHuiyanHolders，打分区那一行也读它）。
  const huiyan = db.getHuiyanHolders();
  for (const uid of huiyan.uids) {
    add(uid, {
      key: 'huiyan',
      label: '慧眼王',
      tip: `慧眼王：慧眼等级最高的（${huiyan.level} 级）`,
    });
  }
  return map;
};

// 个人页「历史各期」。2026-10-15 起**参赛就列**（从前只列交了积分的期）：
// 这一期的胜率分母把"传了阵容没录分"的期也算进去了，这里要是不列，个人页和排行榜
// 就各说各话（榜上写着 1 场 0 胜，个人页却一期都没有）。没交分的那几行 score /
// final_rank 都是 NULL，模板印成「—」，结果那列写「未交积分」。
// players 也是新口径的参赛人数（上传阵容或交过积分），和赛期页、历史页同一个数。
db.getUserHistory = (userPk) => db.prepare(`
  SELECT s.id, s.name, s.created_at, e.score, e.final_rank, e.is_winner,
         (SELECT COUNT(*) FROM entries x WHERE x.season_id = s.id
            AND (x.score IS NOT NULL
                 OR EXISTS (SELECT 1 FROM lineup_images li
                            WHERE li.entry_id = x.id AND li.is_preliminary = 0))) AS players
  FROM entries e JOIN seasons s ON s.id = e.season_id
  WHERE e.user_id = ? AND s.status = 'settled'
    AND (e.score IS NOT NULL
         OR EXISTS (SELECT 1 FROM lineup_images li
                    WHERE li.entry_id = e.id AND li.is_preliminary = 0))
  ORDER BY s.id DESC`).all(userPk);

// 历史赛期列表（/history 和 /admin 都用它）。
//
// ⚠️ 胜者**是一张列表，不是一个字段**。从前写成 `LEFT JOIN entries e ON … AND e.is_winner=1`，
// 那在"一期只有一个胜者"的年代是一行；2026-10-15 改成一期两名胜者之后，同一个赛期会在
// 列表里**出现两行**（管理页那一列还会只剩后一名）。所以改成两条查询 + 在 JS 里归并。
// 胜者按 final_rank 升序（冠军在前），参赛人数是新口径（上传阵容或交过积分）。
db.getHistory = () => {
  const seasons = db.prepare(`SELECT * FROM seasons ORDER BY id DESC`).all();
  const winners = db.prepare(`
    SELECT e.season_id, e.score, e.final_rank, u.nickname, u.user_id AS uid
    FROM entries e JOIN users u ON u.id = e.user_id
    WHERE e.is_winner = 1
    ORDER BY e.season_id, e.final_rank ASC, e.id ASC`).all();
  const bySeason = new Map();
  for (const w of winners) {
    if (!bySeason.has(w.season_id)) bySeason.set(w.season_id, []);
    bySeason.get(w.season_id).push(w);
  }
  const countP = db.prepare(`
    SELECT COUNT(*) AS n FROM entries x WHERE x.season_id = ?
      AND (x.score IS NOT NULL
           OR EXISTS (SELECT 1 FROM lineup_images li
                      WHERE li.entry_id = x.id AND li.is_preliminary = 0))`);
  return seasons.map((s) => ({ ...s, winners: bySeason.get(s.id) || [], players: countP.get(s.id).n }));
};

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
  // 本期前 TOP_N 名的 entry_id。档位本身不区分名次（第一和第二同一张表），
  // 这个集合只用来筛掉"给第三名往后打的票"；本期不足两人时集合里就只有一条。
  const top = new Set(ranking.slice(0, TOP_N).map((row) => row.id));

  const deltas = new Map();                       // users.id → 本期净增减
  for (const r of db.getSeasonRatings(seasonId)) {
    if (!top.has(r.entry_id)) continue;           // 不是给前两名打的，跟他没关系
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

// ---------- 武将索引 / 检索 / 档案 / 纪录（2026-10-17 加） ----------
// 这一整段的公共口径（README 里也写着，改之前先看）：
//   · 只认**卡上第一张阵容图**：老数据里一个 entry 可能有两张图（两套阵容），
//     混起来数会算出假的出场率和 T 级。下面每条带 hero_guesses 的查询都带这个子查询。
//   · chosen_key 为空 / source='none' 的格子 JOIN 不上 heroes，自然排除。
//   · auto = source === 'auto'；统计**全部计入**（用户定的口径），页面上标 ?。
//   · 同一 entry 同一武将如果有多行（历史误填），按 (entry_id, key) 去重，
//     人工行赢 auto 行 —— 和 getSeasonHeroData 完全同一个做法。
//   · 胜率 / 平均分 / 平均互评只算**已结算**期；出场和使用人数算所有期（含进行中）。
//   · 样本不足时返回 null，模板印「样本不足」，不要拿 1 场 100% 当纪录。
const HERO_MIN_SAMPLE = 3;
const RECORD_MIN_PLAYS = 3;
const RECORD_MIN_RATERS = 3;
db.HERO_MIN_SAMPLE = HERO_MIN_SAMPLE;
db.RECORD_MIN_PLAYS = RECORD_MIN_PLAYS;
db.RECORD_MIN_RATERS = RECORD_MIN_RATERS;

// 「卡上第一张**完整**阵容图」。初步图（is_preliminary=1）不算 —— 它不做识别，
// 拿它当 FIRST_IMG 只会把整套武将查询变成空（而且哪天 preliminary 上意外有了
// hero_guesses 行，还会把只展示的图算进统计里，正是用户明确不要的）。
const FIRST_IMG = `(SELECT li.filename FROM lineup_images li
                    WHERE li.entry_id = g.entry_id AND li.is_preliminary = 0
                    ORDER BY li.id LIMIT 1)`;

const round1 = (n) => Math.round(n * 10) / 10;
const displayHeroName = (h) => `${h.variant || ''}${h.name}`;

// 跨赛季按武将聚合。返回**全部武将**（含 0 出场的），这样新武将也能在索引里看到。
db.getHeroIndex = () => {
  const rows = db.prepare(`
    SELECT g.entry_id, g.source, h.key, h.name, h.faction, h.arm, h.variant, h.sort,
           e.user_id, e.score, e.is_winner,
           s.id AS season_id, s.status AS season_status,
           (SELECT AVG(r.value) FROM ratings r WHERE r.entry_id = e.id) AS entry_avg,
           (SELECT COUNT(*) FROM ratings r WHERE r.entry_id = e.id) AS entry_rating_n
    FROM hero_guesses g
    JOIN heroes h ON h.key = g.chosen_key
    JOIN entries e ON e.id = g.entry_id
    JOIN seasons s ON s.id = e.season_id
    WHERE g.filename = ${FIRST_IMG}
  `).all();

  const byHero = new Map();
  for (const h of db.getHeroes()) {
    byHero.set(h.key, {
      key: h.key, name: h.name, variant: h.variant, faction: h.faction,
      arm: h.arm, sort: h.sort, displayName: displayHeroName(h),
      entries: new Set(), users: new Set(), openEntries: new Set(),
      settledEntries: 0, wins: 0, scoredEntries: 0, scores: [],
      ratingN: 0, ratingEntryAvgs: [], autoCells: 0, lastSeasonId: null,
    });
  }

  // 同一个 entry 同一个武将只算一次；人工行赢 auto 行。
  const seen = new Map();          // `${entry_id}:${key}` → { auto }
  for (const r of rows) {
    const hero = byHero.get(r.key);
    if (!hero) continue;           // 库里删了、chosen_key 还留着的孤儿
    const k = `${r.entry_id}:${r.key}`;
    const auto = r.source === 'auto';
    const prev = seen.get(k);
    if (prev) {
      // 先出现的是 auto、后出现的是人工：把这一格的 auto 计数退回去。
      if (prev.auto && !auto) { prev.auto = false; hero.autoCells--; }
      continue;
    }
    const rec = { auto };
    seen.set(k, rec);

    hero.entries.add(r.entry_id);
    hero.users.add(r.user_id);
    if (r.season_status === 'open') hero.openEntries.add(r.entry_id);
    if (r.season_status === 'settled') {
      hero.settledEntries++;
      hero.wins += r.is_winner ? 1 : 0;
      if (r.score !== null) {
        hero.scoredEntries++;
        hero.scores.push(r.score);
      }
      if (r.entry_rating_n > 0) {
        hero.ratingN += r.entry_rating_n;
        hero.ratingEntryAvgs.push(r.entry_avg);
      }
    }
    if (r.lastSeasonId === null || r.season_id > r.lastSeasonId) hero.lastSeasonId = r.season_id;
    if (auto) hero.autoCells++;
  }

  return [...byHero.values()]
    .map((h) => ({
      key: h.key, name: h.name, variant: h.variant, faction: h.faction, arm: h.arm,
      sort: h.sort, displayName: h.displayName,
      entries: h.entries.size, users: h.users.size, openEntries: h.openEntries.size,
      settledEntries: h.settledEntries, wins: h.wins, scoredEntries: h.scoredEntries,
      ratingN: h.ratingN, autoCells: h.autoCells, lastSeasonId: h.lastSeasonId,
      winRate: h.settledEntries >= HERO_MIN_SAMPLE
        ? round1((100 * h.wins) / h.settledEntries) : null,
      avgScore: h.scoredEntries >= HERO_MIN_SAMPLE
        ? round1(h.scores.reduce((a, b) => a + b, 0) / h.scoredEntries) : null,
      avgRating: h.ratingN >= HERO_MIN_SAMPLE && h.ratingEntryAvgs.length
        ? round1(h.ratingEntryAvgs.reduce((a, b) => a + b, 0) / h.ratingEntryAvgs.length) : null,
    }))
    .sort((a, b) => b.entries - a.entries || a.sort - b.sort);
};

// 给一组 entry id 补齐「卡上要展示的东西」：图、第一图武将、互评汇总、积分名次、
// 评论数。武将详情、组合检索、个人档案共用这一份，避免三处各写一遍口径。
const enrichEntryCards = (entryIds, viewerId) => {
  if (!entryIds.length) return [];
  const ph = entryIds.map(() => '?').join(',');
  const entries = db.prepare(`
    SELECT e.id, e.season_id, e.user_id, e.score, e.score_submitted_at, e.lineup_note,
           e.final_rank, e.is_winner,
           s.name AS season_name, s.status AS season_status, s.created_at AS season_created_at,
           u.user_id AS uid, u.nickname
    FROM entries e
    JOIN seasons s ON s.id = e.season_id
    JOIN users   u ON u.id = e.user_id
    WHERE e.id IN (${ph})
    ORDER BY s.id DESC, e.score IS NULL, e.score DESC, e.score_submitted_at ASC, e.id ASC
  `).all(...entryIds);

  const images = new Map();
  for (const img of db.prepare(
    `SELECT * FROM lineup_images WHERE entry_id IN (${ph})
     ORDER BY is_preliminary ASC, id`).all(...entryIds)) {
    if (!images.has(img.entry_id)) images.set(img.entry_id, []);
    images.get(img.entry_id).push(img);
  }

  const heroes = new Map();
  for (const g of db.prepare(`
    SELECT g.entry_id, g.slot, g.source, h.key, h.name, h.faction, h.arm, h.variant
    FROM hero_guesses g
    JOIN heroes h ON h.key = g.chosen_key
    WHERE g.entry_id IN (${ph}) AND g.filename = ${FIRST_IMG}
    ORDER BY h.sort
  `).all(...entryIds)) {
    if (!heroes.has(g.entry_id)) heroes.set(g.entry_id, []);
    const list = heroes.get(g.entry_id);
    const auto = g.source === 'auto';
    const hit = list.find((h) => h.key === g.key);
    if (hit) { if (!auto) hit.auto = false; continue; }
    list.push({ key: g.key, name: g.name, faction: g.faction, arm: g.arm,
                variant: g.variant, slot: g.slot, auto });
  }

  const comments = new Map();
  for (const c of db.prepare(
    `SELECT entry_id, COUNT(*) AS n FROM comments WHERE entry_id IN (${ph}) GROUP BY entry_id`
  ).all(...entryIds)) comments.set(c.entry_id, c.n);

  // 一期一次查打分/名次，期内缓存；不按 entry 逐条回查。
  // 慧眼王的集合整个调用只查一次 —— 它只跟"现在谁是第一"有关，和赛季无关。
  const huiyanUids = db.getHuiyanHolders().uids;
  const seasonCache = new Map();
  const seasonData = (seasonId) => {
    if (!seasonCache.has(seasonId)) {
      const ratings = db.summarizeRatings(db.getSeasonRatings(seasonId), viewerId, huiyanUids);
      const ranks = new Map();
      db.getRanking(seasonId).forEach((r, i) => ranks.set(r.id, i + 1));
      seasonCache.set(seasonId, { ratings, ranks });
    }
    return seasonCache.get(seasonId);
  };

  return entries.map((e) => {
    const sd = seasonData(e.season_id);
    return {
      ...e,
      images: images.get(e.id) || [],
      heroes: heroes.get(e.id) || [],
      rating: sd.ratings.get(e.id) || db.EMPTY_RATING,
      rank: sd.ranks.get(e.id) || null,
      commentsN: comments.get(e.id) || 0,
    };
  });
};

// 某个武将出现过的全部阵容（含进行中），按赛季倒序。viewerId 用来标「我打了几分」。
db.getHeroLineups = (key, viewerId = null) => {
  const ids = db.prepare(`
    SELECT DISTINCT g.entry_id FROM hero_guesses g
    WHERE g.chosen_key = ? AND g.filename = ${FIRST_IMG}
  `).all(key).map((r) => r.entry_id);
  return enrichEntryCards(ids, viewerId);
};

// 双将 / 三将组合检索：先按「同时含这些 key」找 entry，再在内存里做同部队过滤。
// 用 COUNT(DISTINCT) 而不是 N 个 EXISTS —— 一套阵容里同一个武将在两格误填时，
// EXISTS 写法会把「两个 key 其实是同一个」也算成命中，COUNT 不会。
db.getHeroPairLineups = (keys, { sameUnit = false, viewerId = null } = {}) => {
  const clean = [...new Set(keys.filter((k) => db.getHero(k)))];
  if (clean.length < 2) return [];
  const ph = clean.map(() => '?').join(',');
  const ids = db.prepare(`
    SELECT g.entry_id FROM hero_guesses g
    WHERE g.chosen_key IN (${ph}) AND g.filename = ${FIRST_IMG}
    GROUP BY g.entry_id
    HAVING COUNT(DISTINCT g.chosen_key) = ?
  `).all(...clean, clean.length).map((r) => r.entry_id);
  const rows = enrichEntryCards(ids, viewerId);
  if (!sameUnit) return rows;
  return rows.filter((r) => {
    const units = clean.map((k) => {
      const h = r.heroes.find((x) => x.key === k);
      return h ? Math.floor((h.slot - 1) / 3) : null;
    });
    return units.every((u) => u !== null && u === units[0]);
  });
};

// 个人页的阵容档案：该用户所有**至少有一张阵容图**的 entry（含进行中）。
// 初步图也列（它本来就在阵容墙上展示），卡上由模板标「初步」—— 只是不进数据统计。
db.getUserLineupArchive = (userPk) => {
  const ids = db.prepare(`
    SELECT e.id FROM entries e
    WHERE e.user_id = ?
      AND EXISTS (SELECT 1 FROM lineup_images li WHERE li.entry_id = e.id)
  `).all(userPk).map((r) => r.id);
  return enrichEntryCards(ids, userPk);
};

// 近 N 期（**所有已结算期**，含没参加的那几期）。缺席必须显式出现，
// 否则连胜会把隔了一期的两次胜利算成连续。
db.getUserRecentForm = (userPk, limit = 5) => db.prepare(`
  SELECT s.id, s.name, s.created_at, e.score, e.final_rank, e.is_winner,
         CASE WHEN e.id IS NULL THEN 0
              WHEN e.score IS NOT NULL THEN 1
              WHEN EXISTS (SELECT 1 FROM lineup_images li
                           WHERE li.entry_id = e.id AND li.is_preliminary = 0) THEN 1
              ELSE 0 END AS participated
  FROM seasons s
  LEFT JOIN entries e ON e.season_id = s.id AND e.user_id = ?
  WHERE s.status = 'settled'
  ORDER BY s.id DESC
  LIMIT ?
`).all(userPk, limit);

// 常用武将前 N（第一图口径；含进行中的期）。
db.getUserCommonHeroes = (userPk, limit = 5) => db.prepare(`
  SELECT h.key, h.name, h.variant, COUNT(DISTINCT g.entry_id) AS n, h.sort
  FROM hero_guesses g
  JOIN heroes h ON h.key = g.chosen_key
  JOIN entries e ON e.id = g.entry_id
  WHERE e.user_id = ? AND g.filename = ${FIRST_IMG}
  GROUP BY h.key
  ORDER BY n DESC, h.sort ASC
  LIMIT ?
`).all(userPk, limit);

// 首页待办用。「已投 N 套」不能只数墙上的行：图被删掉之后票还在库里。
db.countMyRatings = (seasonId, raterId) => db.prepare(`
  SELECT COUNT(*) AS n FROM ratings r JOIN entries e ON e.id = r.entry_id
  WHERE e.season_id = ? AND r.rater_id = ?
`).get(seasonId, raterId).n;

db.countLineupEntries = (seasonId) => db.prepare(`
  SELECT COUNT(*) AS n FROM entries e
  WHERE e.season_id = ?
    AND EXISTS (SELECT 1 FROM lineup_images li WHERE li.entry_id = e.id)
`).get(seasonId).n;

// 全站纪录。全部现算、不落库；并列全给，样本不足的项返回 null。
db.getRecords = () => {
  // 最高单期积分
  const scoreRows = db.prepare(`
    SELECT e.score, e.id AS entry_id, u.user_id AS uid, u.nickname,
           s.id AS season_id, s.name AS season_name
    FROM entries e
    JOIN seasons s ON s.id = e.season_id
    JOIN users   u ON u.id = e.user_id
    WHERE s.status = 'settled' AND e.score IS NOT NULL
    ORDER BY e.score DESC
  `).all();
  const topScore = scoreRows.length
    ? { value: scoreRows[0].score, holders: scoreRows.filter((r) => r.score === scoreRows[0].score) }
    : null;

  // 最高单期均分（至少 RECORD_MIN_RATERS 人打分）
  const ratingRows = db.prepare(`
    SELECT r.entry_id, AVG(r.value) AS avg, COUNT(*) AS n,
           u.user_id AS uid, u.nickname,
           s.id AS season_id, s.name AS season_name
    FROM ratings r
    JOIN entries e ON e.id = r.entry_id
    JOIN seasons s ON s.id = e.season_id
    JOIN users   u ON u.id = e.user_id
    WHERE s.status = 'settled'
    GROUP BY r.entry_id
    HAVING COUNT(*) >= ?
    ORDER BY avg DESC
  `).all(RECORD_MIN_RATERS);
  let topRating = null;
  if (ratingRows.length) {
    const best = ratingRows[0].avg;
    topRating = {
      value: round1(best),
      holders: ratingRows.filter((r) => r.avg === best)
        .map((r) => ({ ...r, avg: round1(r.avg) })),
    };
  }

  // 最长连胜：只算已结算期；缺席、没交分、没赢都断。
  const settled = db.prepare(`SELECT id, name FROM seasons WHERE status='settled' ORDER BY id ASC`).all();
  const seasonIds = settled.map((s) => s.id);
  const seasonName = new Map(settled.map((s) => [s.id, s.name]));
  const streakRows = db.prepare(`
    SELECT e.user_id, u.user_id AS uid, u.nickname, s.id AS season_id, e.is_winner
    FROM entries e
    JOIN seasons s ON s.id = e.season_id
    JOIN users   u ON u.id = e.user_id
    WHERE s.status = 'settled'
      AND (e.score IS NOT NULL
           OR EXISTS (SELECT 1 FROM lineup_images li
                      WHERE li.entry_id = e.id AND li.is_preliminary = 0))
    ORDER BY e.user_id, s.id ASC
  `).all();
  const byUser = new Map();
  for (const r of streakRows) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, { uid: r.uid, nickname: r.nickname, seasons: new Map() });
    }
    byUser.get(r.user_id).seasons.set(r.season_id, r.is_winner ? 1 : 0);
  }
  let longestStreak = null;
  for (const u of byUser.values()) {
    let cur = 0;
    let best = 0;
    let bestEnd = null;
    for (const sid of seasonIds) {
      if (u.seasons.get(sid) === 1) {
        cur++;
        if (cur > best) { best = cur; bestEnd = sid; }
      } else cur = 0;
    }
    if (best <= 0) continue;
    const holder = {
      uid: u.uid, nickname: u.nickname,
      endSeasonId: bestEnd, endSeasonName: seasonName.get(bestEnd) || '',
    };
    if (!longestStreak || best > longestStreak.value) {
      longestStreak = { value: best, holders: [holder] };
    } else if (best === longestStreak.value) {
      longestStreak.holders.push(holder);
    }
  }

  // 最多胜场 / 最高胜率（至少 RECORD_MIN_PLAYS 期参赛）
  const board = db.getRankBoard();
  const mostWins = board.length && board[0].wins > 0
    ? { value: board[0].wins, holders: board.filter((r) => r.wins === board[0].wins) }
    : null;
  const rateBoard = board
    .filter((r) => r.plays >= RECORD_MIN_PLAYS)
    .sort((a, b) => b.win_rate - a.win_rate || b.wins - a.wins
      || String(a.joined_at).localeCompare(String(b.joined_at)));
  const bestWinRate = rateBoard.length && rateBoard[0].win_rate > 0
    ? { value: rateBoard[0].win_rate, holders: rateBoard.filter((r) => r.win_rate === rateBoard[0].win_rate) }
    : null;

  // 单期最大慧眼涨幅
  const eyeRows = db.prepare(`
    SELECT a.delta, u.user_id AS uid, u.nickname,
           s.id AS season_id, s.name AS season_name
    FROM eye_adjustments a
    JOIN users   u ON u.id = a.user_id
    JOIN seasons s ON s.id = a.season_id
    ORDER BY a.delta DESC
  `).all();
  const eyeGain = eyeRows.length && eyeRows[0].delta > 0
    ? { value: eyeRows[0].delta, holders: eyeRows.filter((r) => r.delta === eyeRows[0].delta) }
    : null;

  return { topScore, topRating, longestStreak, mostWins, bestWinRate, eyeGain };
};

// 某一期的「本期之最」：最高分、口碑最好、最热武将、最大慧眼涨幅。
// 已结算期和进行中的期都能用；进行中的期没有慧眼涨幅（结算时才写）。
db.getSeasonHighlights = (seasonId) => {
  const season = db.getSeason(seasonId);
  if (!season) return null;
  const ranking = season.status === 'settled'
    ? db.getFinalRanking(seasonId) : db.getRanking(seasonId);
  const topScore = ranking.length
    ? {
      value: ranking[0].score,
      holders: ranking.filter((r) => r.score === ranking[0].score)
        .map((r) => ({ uid: r.uid, nickname: r.nickname, score: r.score })),
    }
    : null;

  const wall = db.getLineupWall(seasonId, null);
  const rated = wall.filter((r) => r.rating.avg !== null);
  let topRating = null;
  if (rated.length) {
    const best = Math.max(...rated.map((r) => r.rating.avg));
    topRating = {
      value: best,
      holders: rated.filter((r) => r.rating.avg === best)
        .map((r) => ({ uid: r.uid, nickname: r.nickname, entryId: r.id, avg: r.rating.avg, n: r.rating.n })),
    };
  }

  const heroRows = db.prepare(`
    SELECT h.key, h.name, h.variant, h.faction, h.arm,
           COUNT(DISTINCT g.entry_id) AS n, h.sort
    FROM hero_guesses g
    JOIN heroes h ON h.key = g.chosen_key
    JOIN entries e ON e.id = g.entry_id
    WHERE e.season_id = ? AND g.filename = ${FIRST_IMG}
    GROUP BY h.key
    ORDER BY n DESC, h.sort ASC
  `).all(seasonId);
  const hottestHeroes = heroRows.length
    ? { value: heroRows[0].n, holders: heroRows.filter((r) => r.n === heroRows[0].n) }
    : null;

  const eye = db.getEyeAdjustments(seasonId);
  const eyeGain = eye.length && eye[0].delta > 0
    ? { value: eye[0].delta, holders: eye.filter((r) => r.delta === eye[0].delta) }
    : null;

  return { season, topScore, topRating, hottestHeroes, eyeGain };
};

// ---------- 站点统计（2026-10-19 加） ----------
//
// 为什么要有这一段：站里原来只有"结果性"数据（积分、打分、上场次数），
// 没人知道**每天到底有多少人来**。这里补的是访问侧的最小数据：成员一人一天一行、
// 游客一浏览器一天一行、页面种类一天一行 —— 全是聚合，不存原始日志。
//
// ★ 日界按北京时间。`BJ_OFFSET_MS` 是上面打分截止那一节定义的（北京 = UTC+8，无夏令时），
//   这里复用，别另写一份。
// ★ 只记"页面打开"：GET + 200 + text/html。静态资源、JSON 接口、302 跳转、
//   404 全都不算（见 app.js 的中间件）—— 否则一次页面刷新会被 CSS/JS 灌成十几条。
// ★ 游客的 vid 是 cookie 里的随机 UUID（app.js 发的），**不存 IP / UA**。
//   不装 cookie 的浏览器每次都是新 vid，会被多算 —— 这是有意接受的误差，
//   比为了"准确"去存 IP 强。
const bjDayOf = (ms) => new Date(ms + BJ_OFFSET_MS).toISOString().slice(0, 10);
// 往回数 n 天的日期字符串（n=0 就是当天）。用 UTC 日期做纯日历运算，
// 不经过本地时区 —— 否则服务器跑在美国时区时会差一天。
const dayBack = (day, n) =>
  new Date(Date.parse(`${day}T00:00:00.000Z`) - n * 86400000).toISOString().slice(0, 10);
db.bjDayOf = bjDayOf;

const addActivity = db.prepare(`
  INSERT INTO activity_daily (day, user_id, hits, last_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(day, user_id) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`);
const addVisitor = db.prepare(`
  INSERT INTO visitor_daily (day, vid, hits, last_at) VALUES (?, ?, 1, ?)
  ON CONFLICT(day, vid) DO UPDATE SET hits = hits + 1, last_at = excluded.last_at`);
const addPage = db.prepare(`
  INSERT INTO page_daily (day, page, hits) VALUES (?, ?, 1)
  ON CONFLICT(day, page) DO UPDATE SET hits = hits + 1`);

// 记一次页面打开。app.js 在响应 `finish` 之后调用，所以这里**不能再抛**到请求上 ——
// 调用方已经 try/catch 兜底，但写库本身也保持"三条 upsert 一个事务"，
// 要么都记上，要么一条都不记，不会出现"页面数加了、活跃没加"的半截数据。
const recordPageViewTx = db.transaction((day, userId, vid, page, at) => {
  if (userId) addActivity.run(day, userId, at);
  else if (vid) addVisitor.run(day, String(vid), at);
  addPage.run(day, page);
});
db.recordPageView = ({ userId = null, vid = null, page = '/' } = {}) => {
  const now = Date.now();
  recordPageViewTx(bjDayOf(now), userId, vid, String(page).slice(0, 80), new Date(now).toISOString());
};

// 统计页要的一整份数据。全部现算、不落库（除了上面三张访问表本身）。
// `days` 只影响趋势表的长度，卡片的 7 天 / 30 天窗口是固定的产品口径。
db.getSiteStats = ({ days = 14 } = {}) => {
  const today = bjDayOf(Date.now());
  const weekStart = dayBack(today, 6);
  const monthStart = dayBack(today, 29);
  const trendStart = dayBack(today, days - 1);

  const byDay = (rows, key = 'day') =>
    new Map(rows.map((r) => [r[key], r]));

  // 趋势表只要 days 天，按天的新增也只要这一段 —— 都带上 WHERE，别让表越攒越大之后
  // 每开一次统计页就全表扫一遍。
  const memRows = byDay(db.prepare(`
    SELECT day, COUNT(*) AS dau, SUM(hits) AS pv FROM activity_daily
    WHERE day >= ? GROUP BY day`).all(trendStart));
  const guestRows = byDay(db.prepare(`
    SELECT day, COUNT(*) AS uv, SUM(hits) AS pv FROM visitor_daily
    WHERE day >= ? GROUP BY day`).all(trendStart));
  const pvRows = byDay(db.prepare(`
    SELECT day, SUM(hits) AS pv FROM page_daily
    WHERE day >= ? GROUP BY day`).all(trendStart));
  const signupRows = byDay(db.prepare(`
    SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS n
    FROM users WHERE date(created_at, '+8 hours') >= ? GROUP BY day`).all(trendStart));
  const uploadRows = byDay(db.prepare(`
    SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS n,
           SUM(is_preliminary) AS prelim
    FROM lineup_images WHERE date(created_at, '+8 hours') >= ? GROUP BY day`).all(trendStart));
  const scoreRows = byDay(db.prepare(`
    SELECT date(score_submitted_at, '+8 hours') AS day, COUNT(*) AS n
    FROM entries WHERE score_submitted_at IS NOT NULL
      AND date(score_submitted_at, '+8 hours') >= ? GROUP BY day`).all(trendStart));
  const ratingRows = byDay(db.prepare(`
    SELECT date(created_at, '+8 hours') AS day, COUNT(*) AS n
    FROM ratings WHERE date(created_at, '+8 hours') >= ? GROUP BY day`).all(trendStart));

  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayBack(today, i);
    trend.push({
      day,
      dau: memRows.get(day)?.dau || 0,
      guests: guestRows.get(day)?.uv || 0,
      pv: pvRows.get(day)?.pv || 0,
      signups: signupRows.get(day)?.n || 0,
      uploads: uploadRows.get(day)?.n || 0,
      prelims: uploadRows.get(day)?.prelim || 0,
      scores: scoreRows.get(day)?.n || 0,
      ratings: ratingRows.get(day)?.n || 0,
    });
  }

  const distinctSince = (since) => db.prepare(
    `SELECT COUNT(DISTINCT user_id) AS n FROM activity_daily WHERE day >= ?`).get(since).n;

  // 5 分钟内看过页面的成员 = 在线。last_at 是 ISO 字符串，字典序就是时间序。
  const onlineSince = new Date(Date.now() - 5 * 60e3).toISOString();
  const online = db.prepare(
    `SELECT COUNT(*) AS n FROM activity_daily WHERE day = ? AND last_at >= ?`).get(today, onlineSince).n;

  const topPages = db.prepare(`
    SELECT page, SUM(hits) AS hits FROM page_daily WHERE day >= ?
    GROUP BY page ORDER BY hits DESC, page ASC LIMIT 12`).all(weekStart);

  const topUsers = db.prepare(`
    SELECT a.user_id AS id, u.nickname, u.user_id AS uid,
           COUNT(*) AS days, SUM(a.hits) AS hits, MAX(a.last_at) AS last_at
    FROM activity_daily a JOIN users u ON u.id = a.user_id
    WHERE a.day >= ?
    GROUP BY a.user_id ORDER BY days DESC, hits DESC, a.user_id ASC LIMIT 10`).all(weekStart);

  // 数据从哪一天开始有：三张表取最早的。没访问过（刚发布还没人打开）就是 null。
  const coverage = db.prepare(`
    SELECT MIN(day) AS d FROM (
      SELECT day FROM activity_daily UNION ALL
      SELECT day FROM visitor_daily UNION ALL
      SELECT day FROM page_daily)`).get().d || null;

  const total = {
    users: db.prepare(`SELECT COUNT(*) AS n FROM users`).get().n,
    disabled: db.prepare(`SELECT COUNT(*) AS n FROM users WHERE is_disabled = 1`).get().n,
    seasons: db.prepare(`SELECT COUNT(*) AS n FROM seasons`).get().n,
    lineups: db.prepare(`SELECT COUNT(*) AS n FROM lineup_images WHERE is_preliminary = 0`).get().n,
    prelims: db.prepare(`SELECT COUNT(*) AS n FROM lineup_images WHERE is_preliminary = 1`).get().n,
    ratings: db.prepare(`SELECT COUNT(*) AS n FROM ratings`).get().n,
    comments: db.prepare(`SELECT COUNT(*) AS n FROM comments`).get().n,
    scores: db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE score IS NOT NULL`).get().n,
  };

  // 本期概况（没有进行中的期就是 null）。
  const open = db.getOpenSeason();
  let current = null;
  if (open) {
    current = {
      season: open,
      // 打分截止（统计页上标一下，省得管理员再去翻管理页）
      rateLockAt: db.getRateLockAt(open),
      lineups: db.prepare(`SELECT COUNT(*) AS n FROM lineup_images li
                           JOIN entries e ON e.id = li.entry_id
                           WHERE e.season_id = ? AND li.is_preliminary = 0`).get(open.id).n,
      prelims: db.prepare(`SELECT COUNT(*) AS n FROM lineup_images li
                           JOIN entries e ON e.id = li.entry_id
                           WHERE e.season_id = ? AND li.is_preliminary = 1`).get(open.id).n,
      players: db.prepare(`SELECT COUNT(*) AS n FROM entries e WHERE e.season_id = ?
                           AND (e.score IS NOT NULL
                                OR EXISTS (SELECT 1 FROM lineup_images li
                                           WHERE li.entry_id = e.id AND li.is_preliminary = 0))`).get(open.id).n,
      scores: db.prepare(`SELECT COUNT(*) AS n FROM entries WHERE season_id = ? AND score IS NOT NULL`).get(open.id).n,
      ratings: db.prepare(`SELECT COUNT(*) AS n FROM ratings r
                           JOIN entries e ON e.id = r.entry_id WHERE e.season_id = ?`).get(open.id).n,
    };
  }

  return {
    today,
    coverage,
    cards: {
      dau: memRows.get(today)?.dau || 0,
      guests: guestRows.get(today)?.uv || 0,
      pv: pvRows.get(today)?.pv || 0,
      signups: signupRows.get(today)?.n || 0,
      wau: distinctSince(weekStart),
      mau: distinctSince(monthStart),
      online,
    },
    total,
    current,
    trend,
    topPages,
    topUsers,
  };
};

// 规则页要展示的「单一真源」常量。EYE_GAIN / EYE_BASE / 周几本来只在模块内部用，
// 这里补挂到 db 上（只读），免得 /rules 的文案和代码悄悄分家。
db.EYE_BASE = EYE_BASE;
db.EYE_GAIN = EYE_GAIN;
db.OPEN_WEEKDAY = OPEN_WEEKDAY;
db.FULL_WEEKDAY = FULL_WEEKDAY;
db.LOCK_WEEKDAY = LOCK_WEEKDAY;
db.LOCK_HOUR_BJ = LOCK_HOUR_BJ;

// ---------- 结算 / 撤销（一个事务里做完） ----------
// **积分前 TOP_N 名都算胜者**（用户 2026-10-15 定的口径，从前只有第一名算）。
// 名次照旧一人一个（final_rank 1, 2, 3…），is_winner 才是"算不算赢"那一列 ——
// 胜率和胜场统计读的是它，见上面的 STATS_SQL。
db.settleSeason = db.transaction((seasonId) => {
  const ranking = db.getRanking(seasonId);
  const setRank = db.prepare(`UPDATE entries SET final_rank=?, is_winner=? WHERE id=?`);
  ranking.forEach((row, i) => setRank.run(i + 1, i < TOP_N ? 1 : 0, row.id));
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
