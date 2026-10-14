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

-- 常用索引
CREATE INDEX IF NOT EXISTS idx_entries_season ON entries(season_id);
CREATE INDEX IF NOT EXISTS idx_entries_user   ON entries(user_id);
CREATE INDEX IF NOT EXISTS idx_lineup_entry   ON lineup_images(entry_id);
CREATE INDEX IF NOT EXISTS idx_ratings_entry  ON ratings(entry_id);
CREATE INDEX IF NOT EXISTS idx_ratings_rater  ON ratings(rater_id);
CREATE INDEX IF NOT EXISTS idx_comments_entry ON comments(entry_id);
-- 游客取 /uploads 下的图时**逐文件查库**（app.js 的 canSeeUpload）：一期阵容墙一页
-- 要问几十次，所以给这个平时只按 entry_id 用的列补一条索引。
CREATE INDEX IF NOT EXISTS idx_lineup_filename ON lineup_images(filename);
