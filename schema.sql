PRAGMA foreign_keys = ON;

-- 用户
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE,          -- 自定义 ID，统一存小写
  nickname      TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  is_disabled   INTEGER NOT NULL DEFAULT 0,
  -- 慧眼等级：**所有人初始 10 级**，只在每期结算那一刻动 —— 而且 2026-10-13 起
  -- 只往上加、不会掉（50 / 200 不再扣等级），所以这一列一旦涨上去就是"资历"。
  -- 规则见 db.js 的 EYE_GAIN / eyeDelta。做成一列累计值（而不是每次结算重算）
  -- 是为了能"退回"，见下面 eye_adjustments 的注释。
  eye_level     INTEGER NOT NULL DEFAULT 10,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 键值配置（目前只存邀请码 invite_code；空字符串表示注册已关闭）
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 赛期
CREATE TABLE IF NOT EXISTS seasons (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,                   -- 例如"第32期"
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','settled')),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  settled_at  TEXT
);
-- 同一时间最多一个进行中的赛期
CREATE UNIQUE INDEX IF NOT EXISTS one_open_season ON seasons(status) WHERE status = 'open';

-- 参赛记录（每人每期一条，第一次上传阵容或录分时创建）
CREATE TABLE IF NOT EXISTS entries (
  id                 INTEGER PRIMARY KEY,
  season_id          INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  lineup_note        TEXT,
  score              INTEGER,
  score_image        TEXT,                     -- uploads/ 下的文件名
  score_submitted_at TEXT,                     -- ISO 时间，可以直接按字符串比较
  final_rank         INTEGER,                  -- 结算时写入
  is_winner          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (season_id, user_id),
  -- R4：积分、截图、提交时间三个要么都有，要么都没有
  CHECK ((score IS NULL AND score_image IS NULL AND score_submitted_at IS NULL)
      OR (score IS NOT NULL AND score_image IS NOT NULL AND score_submitted_at IS NOT NULL))
);

-- 阵容截图
CREATE TABLE IF NOT EXISTS lineup_images (
  id         INTEGER PRIMARY KEY,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- 成员之间的打分（互评）。和 entries.score 完全是两回事：
-- score 是玩家自己上传截图的战绩分、决定名次；这里是别人点一下给的评价。
-- 五档固定 50 / 200 / 250 / 300 / 400，值域定义在 db.js 的 RATE_VALUES —— **那是唯一真源**。
-- 它**不进排名、不影响名次**（名次永远只看积分），但两个地方会读它：
-- 首页阵容墙的展示顺序（均分降序），以及结算时的慧眼等级涨跌（见下）。
-- 这里故意不写 CHECK：档位是产品参数、多半还会调整，而 SQLite 改 CHECK 要整表重建；
-- 上面 entries 的 R4 CHECK 守的是不变量（三个字段同生共死），性质不同。
-- 打分的**截止点不在这张表里、也不在任何表里**：每期开期后第一个周四 12:00（北京）
-- 按 seasons.created_at 现算，见 db.getRateLockAt —— 改规矩、撤销结算都自动生效。
CREATE TABLE IF NOT EXISTS ratings (
  id         INTEGER PRIMARY KEY,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  rater_id   INTEGER NOT NULL REFERENCES users(id),   -- 和 entries.user_id 一样：成员只禁用不删除
  value      INTEGER NOT NULL,
  -- 投出去（或改分）的时间。改分时会刷新，和"本人改了积分就刷新提交时间"同一套道理；
  -- 同分时"这个分是谁先给的"就按它排，见 db.getSeasonRatings 的 ORDER BY。
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- 一人一票。期由 entry 带出来，不用再存一遍 season_id。
  -- 「一期内一个阵容只有一票」靠这条唯一约束兜底，不是靠前端把按钮藏起来；
  -- 而**截止前可以改**是 UPDATE 这一行（routes/main.js），不是再插一条。
  UNIQUE (entry_id, rater_id)
);

-- 慧眼等级在结算时的增减明细：一期一人一行，只有"给本期积分第一/第二的人打过分的"
-- 才会有（同一人的多张票先加起来，净增减为 0 的不写）。
-- 这张表**只为一件事存在：撤销结算时把等级原样退回去** ——
-- 不退的话「撤销 → 重新结算」会累加两次，删掉一期也会留下白拿的等级。
-- 也正因为要能退，等级才做成加在 users.eye_level 上的累计值。
CREATE TABLE IF NOT EXISTS eye_adjustments (
  id         INTEGER PRIMARY KEY,
  season_id  INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  delta      INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (season_id, user_id)          -- 顺便充当按赛期查的索引，不再另建
);

-- 阵容卡下面的短留言（每期每套阵容都能留，每条最多 20 字）。
-- 和 ratings 是**两张表、两件事**：打分是"评价这套阵容"，一票一名额、参与慧眼等级结算；
-- 评论只是围观的人留一句话，不占名额、不进任何名次、也不跟结算一起冻结。
-- 字数上限由路由管，**故意不写 CHECK** —— 和 ratings.value 同一性质：上限是产品参数、
-- 多半还会调，而 SQLite 改 CHECK 要整表重建（上面 entries 的 R4 CHECK 守的是不变量，
-- 三个字段同生共死，性质不同）。
-- 跟**阵容卡**走（entry_id），所以删赛期会把评论连卡一起带走，和阵容图同一条路径。
CREATE TABLE IF NOT EXISTS comments (
  id         INTEGER PRIMARY KEY,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  -- 成员发的 → users.id；游客发的 → NULL。**故意可空**，是全库唯一一个可空的成员外键：
  -- 游客在库里没有身份（没有账号，也不给他填名字，一律署名「游客」）。
  -- 删除权限也靠它认人：NULL 就只认管理员（见 routes/public.js）。
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  -- 故意不存 IP：全库到现在没有第二个 IP 字段，不想为了留言新引入一份隐私数据。
  -- 防刷走内存限流（limiter.js 的游客那一段），不靠事后照着 IP 追查。
);

-- 武将库（2026-10-16 加）。102 个武将，数据源是 git-ignored 的 herodata/index.json，
-- 启动时幂等播种（见 db.js 的 seedHeroes）。
-- ★ 卡面是游戏版权素材，**不在这个仓库里** —— 目录不存在时识别功能整体不启用，
--   但下面这两张表和库本身照样能跑（heroes 表空着而已）。
-- ★ 势力/兵种是**从卡面人工读出来的**，不是脚本抓的：上游 sgmdtx.com 的 JSON 里
--   `bz`（兵种）字段 103 个里 80 个都填「盾」，是坏的；`color` 全是 orange，也没用。
--   `zy`（势力）基本准确但个别著名错误（把关平、周仓、徐盛都写成了魏）。
CREATE TABLE IF NOT EXISTS heroes (
  key     TEXT PRIMARY KEY,       -- 拼音 slug，卡面文件名（herodata/cards/<key>.png）也是它
  name    TEXT NOT NULL,          -- 显示名。**不是唯一键**：诸葛亮/SP诸葛亮 同名不同人
  faction TEXT NOT NULL,          -- 魏 / 蜀 / 吴 / 群
  arm     TEXT NOT NULL,          -- 骑 / 弓 / 盾 / 枪
  variant TEXT,                   -- NULL | 'SP' | '群雄' —— 同名两版靠它区分，显示时缀在名字前
  -- **自带战法名**（2026-10-16 加）。游戏里每张卡右边三行战法名，第一行就是这个。
  -- 它在 102 个武将里**零撞名**，连同名变体都各不相同（诸葛亮=草船借箭 /
  -- SP诸葛亮=星罗棋布，孙坚=武烈破虏 / 群雄孙坚=诛凶殄逆）—— 所以它是比"看脸"
  -- 更硬的身份证：本地 OCR 认出这一行就直接定将（见 recognize-ocr.js）。
  -- 同样取自 sgmdtx.com（`wj.skill`）。只作匹配用，界面上不显示。
  skill   TEXT,
  sort    INTEGER NOT NULL DEFAULT 0
);

-- 识别结果（2026-10-16 加）：一张阵容图 9 个格子，一格一行。
--
-- 产品形态（2026-10-16 改版）：**上传后后台自动跑，直接填好结果，玩家事后在阵容卡上纠正。**
-- **三路**识别各出一套候选（第三路 2026-10-16 加）：
--   本地 NCC 模板匹配（`candidates`）+ 远端视觉模型（`vlm`）+ 本地 OCR 认自带战法（`ocr`）。
-- 三路里**≥2 路头名一致**才算高置信（`confidence`）—— 见 recognize.js 的 merge()。
-- （改三路之前是"两路一致"，实测只覆盖 17.6% 的格子；加第三路后覆盖 66.9%、精确率不变。）
-- 玩家的每次纠错都在攒真值，`auto_key` 留住"机器原本说什么"，纠正分析全靠它。
CREATE TABLE IF NOT EXISTS hero_guesses (
  id         INTEGER PRIMARY KEY,
  entry_id   INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,       -- lineup_images.filename，同一张图 9 行
  slot       INTEGER NOT NULL,    -- 1..9，行优先（部队一 1-3、二 4-6、三 7-9）
  -- 候选快照（JSON）。**故意存快照而不是只存外键**：库会随版本变，
  -- 而"当时机器猜的是什么"是历史事实，反馈分析要的就是它，不该被后来的库覆盖。
  candidates TEXT NOT NULL,       -- NCC 的前 3 个
  vlm        TEXT,                -- 视觉模型的前 3 个（JSON）。没跑或跑挂了为 NULL
  -- 本地 OCR（认自带战法名）的结果（JSON）。**每格最多一个**，不是"前 3 个"——
  -- 这一路的答案是"这格第一行印的是哪个自带战法"，是一对一的，没有第二名可言。
  -- 没跑或跑挂了为 NULL。
  -- ⚠️ 它**不是每格独立裁窗**算出来的：整块阵容区 OCR 一遍，拿 102 个自带战法名去撞、
  --    按文字块的坐标聚成 3×3，再取每格最靠上的那个。所以一张图是**同生共死**的：
  --    服务挂掉时 9 格全 NULL（不像 NCC 会"某几格没候选"）。
  ocr        TEXT,
  -- 卡上显示的那个：机器自动填的和玩家纠正后的，都写这儿。
  -- **故意不写 REFERENCES heroes(key)**：库是播种出来的、可能被重播，
  -- 而玩家的决定是这张表里最值钱的数据，不能因为库里少了一个武将就被级联删掉或写不进去。
  chosen_key TEXT,
  -- 机器自动填的那个。玩家改过之后 chosen_key 就变了，而这一列**永不覆盖** ——
  -- /admin 那块「定期总结修复」的排行榜（机器说 X → 玩家改成 Y）全靠它。
  auto_key   TEXT,
  confidence TEXT,                -- 'high'（三路里 ≥2 路头名一致）/ 'low'（没有多数，或只有一路有输出）
  source     TEXT,                -- 'auto'（机器填的）/ 'pick' / 'other' / 'none'（后三个是玩家动作）
  other_name TEXT,                -- source='other' 时玩家手输的原文，哪怕没能对上库里任何一个
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- ★ **只有人动过才写**。自动填绝不碰它 —— 它从此是「有没有人核对过」的唯一判据：
  --   NULL = 机器填的、没人看过；非 NULL = 本人或管理员确认/改过。
  --   把这两个混起来的话，「玩家纠正了什么」就再也算不出来了。
  decided_at TEXT,
  -- 一张图的同一格只有一行。重跑识别 = 覆盖候选与自动填，但**不动人工的结论**。
  UNIQUE (filename, slot)
);

-- 常用索引
CREATE INDEX IF NOT EXISTS idx_entries_season ON entries(season_id);
CREATE INDEX IF NOT EXISTS idx_guesses_filename ON hero_guesses(filename);
CREATE INDEX IF NOT EXISTS idx_guesses_entry ON hero_guesses(entry_id);
CREATE INDEX IF NOT EXISTS idx_entries_user   ON entries(user_id);
CREATE INDEX IF NOT EXISTS idx_lineup_entry   ON lineup_images(entry_id);
CREATE INDEX IF NOT EXISTS idx_ratings_entry  ON ratings(entry_id);
CREATE INDEX IF NOT EXISTS idx_ratings_rater  ON ratings(rater_id);
CREATE INDEX IF NOT EXISTS idx_comments_entry ON comments(entry_id);
-- 游客取 /uploads 下的图时**逐文件查库**（app.js 的 canSeeUpload）：一期阵容墙一页
-- 要问几十次，所以给这个平时只按 entry_id 用的列补一条索引。
CREATE INDEX IF NOT EXISTS idx_lineup_filename ON lineup_images(filename);
