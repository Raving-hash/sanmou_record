const db = require('../db');
const r2 = require('../r2');
const {
  removeFile, removeFiles, readKeys, THUMB_SUFFIX, MAX_OUT_BYTES, MAX_LINEUP, IMG_TYPE,
} = require('../upload');
const reco = require('../recognize-worker');
const returnto = require('../returnto');
const router = require('express').Router();

/* 提交时的**对象复核**。图片是浏览器直传到 R2 的，服务端没见过那些字节，
   所以入库前必须确认"确实传上去了，而且体积和类型都对"。

   防的是什么：
     · 客户端瞎报一个 key（Token 那关已经挡住了**别人的** key，但"我领了却没传"
       是通的 —— 关掉标签页、网络断了都会这样）；
     · 客户端撒谎说"我压到 1MB 以下了"（presigned PUT 管不住体积，
       R2 也不支持 content-length-range 的 POST 策略，只能在事前签发 +
       事后复核这两头夹）；
     · 有人拿这张 URL 传了别的东西（content-type 签进签名了，理论上传不了
       非 jpeg；复核是第二道）。

   并发发出去（Promise.all）—— 6 张图 = 12 个请求，串行按每个 150ms 算就是 1.8s，
   而这几个请求还要过宿主机那条代理。 */
async function verifyUploaded(keys) {
  const wanted = [];
  for (const k of keys) { wanted.push(k); wanted.push(k + THUMB_SUFFIX); }
  const heads = new Map();
  await Promise.all(wanted.map(async (key) => {
    try { heads.set(key, await r2.head(key)); }
    catch (e) { heads.set(key, { exists: false, why: e.message }); }
  }));

  const ok = [];
  const bad = [];
  for (const k of keys) {
    const a = heads.get(k) || {};
    const b = heads.get(k + THUMB_SUFFIX) || {};
    let why = null;
    if (!a.exists) why = '原图没传上去';
    else if (a.size > MAX_OUT_BYTES) why = `原图 ${(a.size / 1024 / 1024).toFixed(1)}MB，超过 ${MAX_OUT_BYTES / 1024 / 1024}MB 上限`;
    else if (a.type !== IMG_TYPE) why = `原图类型是 ${a.type || '空'}，只收 jpeg`;
    // 缩略图**必须**有：从前没有还能靠 ensureThumb 现补，现在服务端不碰字节了，
    // 缺了就是阵容墙上一个永久的空格子。
    else if (!b.exists) why = '缩略图没传上去';
    else if (b.type !== IMG_TYPE) why = `缩略图类型是 ${b.type}`;
    if (why) bad.push({ key: k, why }); else ok.push(k);
  }
  return { ok, bad };
}

// 给排名行挂上各自的阵容截图
const withImages = (rows) => rows.map((r) => ({ ...r, images: db.getLineupImages(r.id) }));

// ---------- 结算战报（那段贴群里的纯文本） ----------
// 每期结算完都要往群里发一次成绩，从前只能照着页面手打一遍。这里把它拼成一段纯文本，
// 页面上摆进一个 <textarea readonly> 让人全选复制（见 views/season.ejs + public/report.js）。
//
// 为什么拼在服务端而不是模板里：模板要一格一格 <%= %> 拼十几行文本、还得自己管换行，
// 而这本来就是"从数据里算出四个字"的活儿。放这儿一眼能看清最终长什么样。
// 为什么不用 Markdown：QQ / 微信都不渲染，星号和井号只会变成噪声 —— 纯文本 + 两个 emoji 就够。
//
// rows 是 getFinalRanking 的结果（已结算，**只有交了积分的人** —— 没分就没名次）；
// wall 是 getLineupWall 的结果（已结算的期按积分降序，见 db.isWallByScore）；eye 是
// getEyeAdjustments 的结果；
// players 是这一期的**参赛人数**（db.countPlayers：上传了阵容就算参与）。
// 首行两个数都得有：参赛的人里往往只有一部分交了积分（2026-10-15 起这两件事彻底分开了），
// 只报"参赛 N 人"、底下却只列得出一小半人，看着像漏了谁。
const buildReport = (season, rows, wall, eye, players) => {
  const lines = [`【${season.name} · 演武积分赛】${players} 人参赛 · ${rows.length} 人交分`];

  // 积分前两名都算胜者（2026-10-15 起），两行都印 👑，因此不出现"2."。
  rows.forEach((r, i) => lines.push(`${i < db.TOP_N ? '👑 ' : `${i + 1}. `}${r.nickname}  ${r.score} 分`));

  // 口碑最好 = 阵容墙上互评均分最高的那几位。**读的是墙那份 rows**（不另写一条 SQL）：
  // 自己 GROUP BY 一遍的话，口径会和墙悄悄分家 —— 墙上还包含"传了阵容但没交积分"的人
  // （见 db.getLineupWall 的 WHERE），那样就会出现"墙上第一行是甲、战报却写乙"。
  // 并列的全列出来：只有五档，并列太常见，只挑一个是误导（同 maxBy / minBy 的处理）。
  // 均分和人数**逐个人各写一遍**：并列的几条投票数往往不一样，共用一个数就成了假话。
  // ⚠️ 均分**自己取最大值**，不许写 `rated[0]`：那等于默认"wall 一定按均分降序"，
  // 而 2026-10-14 起这个前提有了例外 —— 首页"刚投完票跳回来"的那一次是按冻结顺序排的
  // （见下面 lineupWall）。反正战报只在已结算的期出，这里显式算一遍最稳。
  const rated = wall.filter((r) => r.rating.avg !== null);
  if (rated.length) {
    const best = Math.max(...rated.map((r) => r.rating.avg));
    const who = rated.filter((r) => r.rating.avg === best)
      .map((r) => `${r.nickname}（均分 ${r.rating.avg} · ${r.rating.n} 人打分）`);
    lines.push(`🏆 口碑最好：${who.join('、')}`);
  }

  // 「+」自己带：虽然慧眼等级只涨不跌（db.js 的 EYE_GAIN 一个负数都没有），
  // 但 /admin 的结算提示就是这么拼的，跟着它写，将来真出现负数也不会印成「-3」这种半截话。
  if (eye.length) {
    lines.push(`👁 慧眼等级：${eye.map((e) => `${e.nickname} ${e.delta > 0 ? '+' : ''}${e.delta}`).join('、')}`);
  }

  return lines.join('\n');
};

// ---------- 阵容墙的顺序（首页专用） ----------
// 平常就是 db.getLineupWall 的默认顺序（打分截止前按互评均分降序，截止后按积分降序，
// 见 db.isWallByScore）。只有一种例外：**刚从打分 POST 跳回来的那一次**，按上一次渲染的
// 顺序原样排一遍 —— 用户 2026-10-14 的口径是「打分以后不动，刷新网页再重排」。
// 投一票会改均分，而截止之前顺序就是均分定的，不冻一下的话整页重刷回来顺序就变了：
// 正在看的卡片当场跳走，还得重新找它在哪。
//
// 那个"上一次的顺序"记在 session 里（一张逗号分隔的 entry id），不是另建表 ——
// 它只活到下一次页面渲染，没有留档的价值。**只生效一次**：读到的同时就把标记删掉，
// 于是用户自己刷新（或者从导航点进来）时按最新的顺序重排。
// ⚠️ 顺序对不上期号时一律当没冻过（跨期之后那些 id 也不该再提位置）。
//
// 标记存的是**投出去的时刻**，不是 true：只认"刚投完"的那一跳（5 分钟以内）。投完直接
// 关掉标签页、隔半天才回来的人也走得通 —— 那时旧顺序早没意义了，按最新的顺序排才对。
const WALL_HOLD_MS = 5 * 60 * 1000;

const lineupWall = (req, season, viewerId) => {
  const heldAt = Number(req.session.wallHold || 0);
  delete req.session.wallHold;                       // 一次性，用完即清
  const held = heldAt > 0 && Date.now() - heldAt < WALL_HOLD_MS;
  const frozen = held && req.session.wallOrderSeason === season.id
    ? String(req.session.wallOrder || '')
      .split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  // isAdmin 传下去只为一件事：管理员也要能改别人的识别结果（认错了总得有人能修）。
  const rows = db.getLineupWall(season.id, viewerId, frozen, !!req.user?.is_admin);

  // 记下这一版的顺序，给"下次投完票跳回来"用。**只在真的变了才赋值**：cookie-session
  // 把整个 session 塞在一张 cookie 里，每赋一次值都要重签一份 Set-Cookie。
  const order = rows.map((r) => r.id).join(',');
  if (req.session.wallOrder !== order || req.session.wallOrderSeason !== season.id) {
    req.session.wallOrder = order;
    req.session.wallOrderSeason = season.id;
  }
  return rows;
};

// ---------- 阵容墙筛选（2026-10-17 加） ----------
// 墙本身只有十几套，过滤放在 getLineupWall **之后**做：
// #N 是积分名次，由 getLineupWall 按全期名次算好；先筛再数会把名次重编。
// 所有参数都只从白名单里取，非法值直接忽略 —— 一个手打地址不该把页面打成 500。
const FACTION_VALUES = ['魏', '蜀', '吴', '群'];
const ARM_VALUES = ['骑', '弓', '盾', '枪'];
const TIER_VALUES = ['T0', 'T1', 'T2', 'T3'];

const parseWallFilters = (query) => {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const str = (v) => String(one(v) ?? '').trim();
  const f = {};

  const hero = str(query.hero);
  if (hero && db.getHero(hero)) f.hero = hero;
  const faction = str(query.faction);
  if (FACTION_VALUES.includes(faction)) f.faction = faction;
  const arm = str(query.arm);
  if (ARM_VALUES.includes(arm)) f.arm = arm;
  const tier = str(query.tier).toUpperCase();
  if (TIER_VALUES.includes(tier)) f.tier = tier;
  const scored = str(query.scored);
  if (scored === '1' || scored === '0') f.scored = scored;
  const mine = str(query.mine);
  if (mine === 'rated' || mine === 'unrated') f.mine = mine;
  const text = str(query.q).slice(0, 20);
  if (text) f.q = text;

  return f;
};

const filterWall = (rows, f) => {
  if (!Object.keys(f).length) return rows;
  const q = f.q ? f.q.toLowerCase() : null;
  return rows.filter((r) => {
    if (f.hero && !r.heroes.some((h) => h.key === f.hero)) return false;
    if (f.faction && !r.heroes.some((h) => h.faction === f.faction)) return false;
    if (f.arm && !r.heroes.some((h) => h.arm === f.arm)) return false;
    if (f.tier && db.lineupTier(r.heroes).tier !== f.tier) return false;
    if (f.scored === '1' && r.score === null) return false;
    if (f.scored === '0' && r.score !== null) return false;
    if (f.mine === 'rated' && !r.rating.mine) return false;
    if (f.mine === 'unrated' && r.rating.mine) return false;
    if (q && !String(r.nickname).toLowerCase().includes(q)) return false;
    return true;
  });
};

const filterQuery = (f) => {
  const params = new URLSearchParams();
  for (const k of ['hero', 'faction', 'arm', 'tier', 'scored', 'mine', 'q']) {
    if (f[k]) params.set(k, f[k]);
  }
  return params.toString();
};

// 表单里的 returnTo / 旧版 back → 安全的站内地址。赛季墙会核对期号，
// 免得从 A 期的卡跳回 B 期的墙。取不到就回 fallback。
const safeReturn = (req, fallback = '/', seasonId = null) => {
  const raw = req.body.returnTo || (req.body.back === 'wall' ? '/wall' : '/');
  return returnto.safe(raw, fallback, { seasonId });
};

// ---------- 本期看板 ----------
router.get('/', (req, res) => {
  const season = db.getOpenSeason();

  if (season) {
    const entry = db.findEntry(season.id, req.user.id);
    // 打分截到每期开期后第一个周四 12:00（北京），过点整期封盘：不出按钮、也不收 POST。
    // 和名额一样现算（db.getRateLockAt），所以撤销结算后如果还在窗口里，按钮自己就回来了。
    // 能不能打分问 isRateLocked，别自己比大小：万一 created_at 是坏的、算不出截止点，
    // 它按"没封盘"处理，和 POST 那道关同一个口径 —— 否则会出现墙上不出按钮、
    // 手动 POST 却写得进去的错位。
    const rateLockAt = db.getRateLockAt(season);
    const canRate = !db.isRateLocked(season);

    // 墙的筛选（2026-10-17）。**先取全量、再过滤**：#N 是全期积分名次，
    // 由 db.getLineupWall 先算好；过滤只影响展示，不能重编号。
    // wallReturn 会写进打分/评论/纠错的 hidden returnTo，投完票跳回来时筛选不丢。
    const allLineups = lineupWall(req, season, req.user.id);
    const filters = parseWallFilters(req.query);
    const filterQS = filterQuery(filters);
    // 2026-10-19：卡片**全部**交给模板渲染，不匹配的挂 .is-hidden。
    // 为什么要渲染不匹配的：首页换武将不再刷新页面（public/home-filter.js 直接收放卡片），
    // 页面里没有的卡就再也放不出来了。没有 JS 时 .is-hidden 就是 display:none ——
    // GET 表单提交后看到的和从前一模一样，只多了一点隐藏的标记。
    //   visibleIds     = 当前**全部**条件筛完的结果（首屏该露出来的卡）
    //   restVisibleIds = 去掉「武将」那条以后的结果：客户端换武将时拿它当底，
    //                    不能把被势力/积分等条件筛掉的卡也放出来。
    const visibleIds = new Set(filterWall(allLineups, filters).map((r) => r.id));
    const restFilters = { ...filters };
    delete restFilters.hero;
    const restVisibleIds = new Set(filterWall(allLineups, restFilters).map((r) => r.id));
    const lineups = allLineups;
    const wallReturn = filterQS ? `/?${filterQS}` : '/';
    // 待办卡里「去打分」优先落到第一张还没打分的卡；没有就回墙顶。
    const firstUnrated = allLineups.find((r) => r.rating.mine === null);
    // 筛选说明（页面上给一句人话，不把 query 原样吐出来）。
    const filterLabels = [];
    if (filters.hero) {
      const h = db.getHero(filters.hero);
      if (h) filterLabels.push(`武将 ${h.variant || ''}${h.name}`);
    }
    if (filters.faction) filterLabels.push(`势力 ${filters.faction}`);
    if (filters.arm) filterLabels.push(`兵种 ${filters.arm}`);
    if (filters.tier) filterLabels.push(`评级 ${filters.tier}`);
    if (filters.scored === '1') filterLabels.push('只看已交分');
    if (filters.scored === '0') filterLabels.push('只看未交分');
    if (filters.mine === 'rated') filterLabels.push('我打过分');
    if (filters.mine === 'unrated') filterLabels.push('我还没打分');
    if (filters.q) filterLabels.push(`昵称含「${filters.q}」`);
    const filterNote = filterQS
      ? `筛选：${filterLabels.join(' · ')}（${visibleIds.size} / ${allLineups.length} 套）`
      : null;

    return res.render('home', {
      title: '本期看板',
      season,
      last: null,
      // ranking **不传**：进行中的期首页整节不渲染「本期排名」（2026-10-14 用户的口径 ——
      // 结算以前没有名次，那一节只会剩一句"还没有人交积分"）。名次去 /seasons/:id 看。
      // 和 eye 一样：只被另一条分支用到的 local，就不在这条分支里查、也不传。
      // 反过来说 —— 要在这条分支里再摆一张排名表，得先把 local 传回来：模板里引用一个
      // 没传进来的名字是 ReferenceError（整页 500），而这条分支是开发站天天在走的那条，
      // 一改就能撞出来。
      lineups,
      allLineupCount: allLineups.length,
      // 卡片的可见性（见上面 visibleIds / restVisibleIds 的说明）。matchCount 给空态用：
      // lineups 现在是全量，"有没有筛出东西"不能再拿它的长度冒充。
      visibleIds,
      restVisibleIds,
      matchCount: visibleIds.size,
      filters,
      filterQuery: filterQS,
      filterActive: !!filterQS,
      filterNote,
      wallReturn,
      heroes: db.getHeroes(),
      factions: FACTION_VALUES,
      arms: ARM_VALUES,
      tiers: TIER_VALUES,
      firstUnrated,
      // 墙上那句顺序说明要跟数据一致：截止前按均分、截止后按积分（见 db.isWallByScore）。
      // 和 db.getLineupWall 里用的是同一个判断，所以不会出现"页面上写着按积分、卡片却按均分排"。
      byScore: db.isWallByScore(season),
      // 本期我的打分名额（只含有限额的档位）。阵容墙用它把投满的档位按钮灰掉、
      // 在标题下面列一行"还剩几个"。没在打分的人也会看到，但那是他自己的数，无妨。
      // 封盘后不查了：那时一个按钮都不出，名额行也就没地方显示。
      quota: canRate ? db.getMyQuota(season.id, req.user.id) : [],
      canRate,
      rateLockAt,
      // 本周待办要用的几个状态（views/home.ejs 的 todo 卡）。
      // uploadPhase：closed / preliminary / full —— 三段的判定只在 db.getUploadPhase 一处，
      // 模板不自己比时间（周二初步窗口 → 周三完整窗口）。
      uploadOpenAt: db.getUploadOpenAt(season),
      fullUploadAt: db.getFullUploadAt(season),
      uploadPhase: db.getUploadPhase(season),
      uploadClosed: db.isLineupClosed(season),
      myRatingCount: db.countMyRatings(season.id, req.user.id),
      notSubmitted: db.getNotSubmitted(season.id),
      me_entry: entry,
      me_images: entry ? db.getLineupImages(entry.id) : [],
      myRank: null,
    });
  }

  // 没有进行中的期 → 显示上一期结果
  const last = db.getLastSeason();
  let myRank = null;
  if (last && last.status === 'settled') {
    const i = db.getRanking(last.id).findIndex((r) => r.user_id === req.user.id);
    if (i >= 0) myRank = i + 1;
  }
  res.render('home', {
    title: '本期看板',
    season: null,
    last,
    ranking: last ? withImages(db.getRanking(last.id)) : [],
    lineups: last ? db.getLineupWall(last.id, req.user.id, null, !!req.user.is_admin) : [],
    // 已结算的期一律按积分排（见 db.isWallByScore），墙上那句说明跟着一起换。
    byScore: db.isWallByScore(last),
    // 结算时的慧眼等级变动（没有 settled 的期就是空的）。这个回退分支显示的
    // 一定是已结算的期，所以榜直接摆出来，不用再判一次状态。
    eye: last ? db.getEyeAdjustments(last.id) : [],
    notSubmitted: [],
    me_entry: null,
    me_images: [],
    myRank,
  });
});

// ---------- 本期阵容 ----------
router.get('/lineup', (req, res) => {
  const season = db.getOpenSeason();
  if (!season) return res.redirect('/');
  const entry = db.findEntry(season.id, req.user.id);
  res.render('lineup', {
    title: '上传阵容',
    season,
    entry,
    images: entry ? db.getLineupImages(entry.id) : [],
    max: MAX_LINEUP,
    // 上传窗口（2026-10-18 改口径）：周二 12:00 起可传「初步图」（只作展示），
    // 周三 12:00 起传的「完整图」会覆盖它。三段判定只在 db.getUploadPhase 一处。
    // 关着的时候页面不出上传组件。但**真正拦人的是下面 POST 那一道** ——
    // 这里只是别让玩家挑完图才被弹回来。
    uploadPhase: db.getUploadPhase(season),
    uploadClosed: db.isLineupClosed(season),
    uploadOpenAt: db.getUploadOpenAt(season),
    fullUploadAt: db.getFullUploadAt(season),
    // 现在这幅图是初步图还是完整图（决定页面上那句说明和「覆盖」提示怎么写）。
    hasFullImage: entry ? db.getLineupImages(entry.id).some((i) => !i.is_preliminary) : false,
  });
});

/* 提交阵容。字节已经由浏览器直传到 R2 了，这里只收到一批**令牌**
   （`images` = "key|过期时间|签名"，见 upload.js）。

   和从前的差别只有"文件名从哪来"：从前是 multer 收了字节之后服务端自己造的，
   现在是**客户端回传 + 服务端验签**。所以多了一道 readKeys 的校验，
   其余的业务逻辑（赛期、配额、事务）一行没动。 */
router.post('/lineup', async (req, res) => {
  const note = String(req.body.lineup_note || '').trim().slice(0, 1000);
  const { keys, bad } = readKeys(req, 'images');

  const season = db.getOpenSeason();
  if (!season) {
    await removeFiles(keys);
    req.session.flash = { type: 'err', msg: '当前没有进行中的赛期' };
    return res.redirect('/');
  }

  // ★ 上传窗口。**拦人的那一道在这儿，不在界面上** —— 藏掉表单挡不住直接 POST。
  //   判据只看时间（见 db.getUploadPhase）。打回时**必须把对象删掉**：
  //   浏览器已经把字节传到 R2 了，不删就是一堆没入库的孤儿（r2-gc 才收得掉）。
  //
  //   2026-10-18 起窗口分两段：周二 12:00–周三 12:00 传的是「初步图」（只展示、
  //   不识别、不进数据）；周三 12:00 之后传的是「完整图」，会覆盖掉那张初步图。
  //   阶段**由服务端按时刻判定**，不收客户端传来的任何标记 —— 否则手搓一个 POST
  //   就能把初步图洗成完整图。
  const phase = db.getUploadPhase(season);
  if (phase === 'closed') {
    await removeFiles(keys);
    req.session.flash = {
      type: 'err',
      msg: `阵容要到 ${res.locals.fmt(db.getUploadOpenAt(season))} 才开放上传`,
    };
    return res.redirect('/lineup');
  }
  const preliminary = phase === 'preliminary';

  const entry = db.getOrCreateEntry(season.id, req.user.id);
  const existing = db.getLineupImages(entry.id);
  const prelims = existing.filter((i) => i.is_preliminary);
  const fulls = existing.filter((i) => !i.is_preliminary);

  // 令牌没过（过期、被改过、或者根本不是这台服务器发的）→ 整批打回。
  // 已经验过的那几个也一并删掉：它们进不了库，留着就是孤儿（r2-gc 也会清，
  // 但没必要故意留给它）。
  if (bad.length) {
    await removeFiles(keys);
    req.session.flash = { type: 'err', msg: '上传凭证无效或已过期，请刷新页面重传' };
    return res.redirect('/lineup');
  }

  const { ok, bad: unverified } = await verifyUploaded(keys);
  if (unverified.length) {
    await removeFiles(keys);
    req.session.flash = {
      type: 'err',
      msg: `有 ${unverified.length} 张没传成功（${unverified[0].why}），请重传`,
    };
    return res.redirect('/lineup');
  }

  // 已经在用的 key 跳过，不再插一行。两道：
  //  · 批内去重 —— readKeys 已经做过；
  //  · 库里已引用 —— `lineup_images.filename` **没有 UNIQUE 约束**（schema.sql），
  //    同一张图被两行引用的话，删掉其中一行会把对象删掉、另一行就成了坏图。
  //    回退按钮重发一次表单是能走到这儿的，所以这里安静跳过而不是报错，
  //    只在提示语里说一声。
  const fresh = ok.filter((k) => !db.isImageInUse(k));
  const dup = ok.length - fresh.length;

  // 完整图窗口里，如果提交的正是**之前那张初步图的 key**（回退按钮重发表单就会这样），
  // 不新增一行，而是把旧行原地升成完整图 —— 否则 fresh 为空、下面又会把初步图删掉，
  // 结果是一张图都不剩。
  const promote = preliminary ? [] : prelims.filter((p) => ok.includes(p.filename));
  // 真正要被覆盖掉的旧初步图：只有在**这次确实传上了完整图**时才删。
  // 只改阵容说明（没选文件）也把初步图删掉，等于替玩家把图撤了，不是覆盖的意思。
  const replaced = preliminary || (!fresh.length && !promote.length)
    ? []
    : prelims.filter((p) => !promote.includes(p));

  if (preliminary) {
    // 初步窗口里和从前一样：每期一张，换图先删旧的（初步图本身没有数据，删了不可惜）。
    if (existing.length + fresh.length > MAX_LINEUP) {
      await removeFiles(keys);
      req.session.flash = { type: 'err', msg: '每期只能传一张阵容图，要换请先删掉现在这张' };
      return res.redirect('/lineup');
    }
  } else if (fulls.length + fresh.length + promote.length > MAX_LINEUP) {
    // 完整图窗口：手上有完整图就传不进第二张 —— 和从前一样先删再传。
    // 只有初步图时例外，那是**覆盖**（见下面的事务）。
    await removeFiles(keys);
    req.session.flash = {
      type: 'err',
      msg: fulls.length
        ? '每期只能传一张完整阵容图，要换请先删掉现在这张'
        : '每期只能传一张阵容图，要换请先删掉现在这张',
    };
    return res.redirect('/lineup');
  }

  const ins = db.prepare(
    'INSERT INTO lineup_images (entry_id, filename, is_preliminary) VALUES (?, ?, ?)');
  const del = db.prepare('DELETE FROM lineup_images WHERE id=?');
  const setFull = db.prepare('UPDATE lineup_images SET is_preliminary=0 WHERE id=?');
  db.transaction(() => {
    for (const p of promote) setFull.run(p.id);
    for (const p of replaced) del.run(p.id);
    for (const n of fresh) ins.run(entry.id, n, preliminary ? 1 : 0);
    db.prepare('UPDATE entries SET lineup_note=? WHERE id=?').run(note || null, entry.id);
  })();   // 只改阵容不动 score_submitted_at，提交时间不变

  // 覆盖掉的旧图要连 R2 上的对象一起删 —— 不删就是一张没人引用的孤儿图。
  // 和别处的删除一样不 await（删远端不该拖着用户等）。
  if (replaced.length) removeFiles(replaced.map((p) => p.filename));

  // 排队做阵容识别。**只推文件名，不在这儿算** —— 一张图约 2.5 秒，
  // 同步跑会把请求卡住（详见 recognize-worker.js 的头注释）。
  // 结果写进 hero_guesses，玩家在阵容卡上确认（见 views/partials/reco.ejs）。
  // ★ **初步图不入队**（用户 2026-10-18 的原话："这个不做识图"）。
  //   升成完整图的那张则要补进队（它当初传的时候是初步图，没认过）。
  if (!preliminary) {
    [...fresh, ...promote.map((p) => p.filename)].forEach((n) => reco.enqueue(n, entry.id));
  }

  const parts = [];
  if (fresh.length) {
    parts.push(preliminary
      ? '已上传初步阵容图（只作展示；周三 12:00 后传完整阵容会覆盖它）'
      : `已上传 ${fresh.length} 张完整阵容截图`);
  }
  if (promote.length) parts.push('已把初步阵容图换成完整阵容图');
  if (replaced.length) parts.push('之前的初步阵容图已覆盖');
  if (dup) parts.push(`${dup} 张已经在用，跳过`);
  req.session.flash = {
    type: 'ok',
    msg: parts.length ? parts.join(' · ') : '阵容说明已保存',
  };
  res.redirect('/lineup');
});

router.post('/lineup/:imgId/delete', (req, res) => {
  const img = db.getLineupImage(Number(req.params.imgId));
  if (!img) return res.redirect('/lineup');

  const entry = db.getEntry(img.entry_id);
  const season = db.getSeason(entry.season_id);
  const allowed = (entry.user_id === req.user.id || req.user.is_admin) && season.status === 'open';
  if (!allowed) return res.status(403).send('这张图不能删');

  db.prepare('DELETE FROM lineup_images WHERE id=?').run(img.id);
  removeFile(img.filename);

  res.redirect(req.body.back === 'season' ? `/seasons/${season.id}` : '/lineup');
});

// ---------- 录入积分 ----------
router.get('/score', (req, res) => {
  const season = db.getOpenSeason();
  if (!season) return res.redirect('/');
  res.render('score', {
    title: '录入积分',
    season,
    entry: db.findEntry(season.id, req.user.id),
    error: null,
  });
});

/* 提交积分（2026-10-17 改口径：**只填分就行，截图不是必填**）。
   和 /lineup 同一套字节直传：这里只收一个 `image_key` 令牌，收不到就当没图。
   老用户库里可能还留着从前传的截图 —— 不带图再提交时**沿用那一张**（不主动删），
   真要清掉走「撤回积分」（它会把分和截图一起清）。 */
router.post('/score', async (req, res) => {
  const season = db.getOpenSeason();
  if (!season) return res.redirect('/');

  const { keys, bad } = readKeys(req, 'image_key');
  const given = keys[0] || null;   // 只收一张

  // 表单校验没过 → 把刚传上去的那张删掉（和从前 removeFile(req.file.filename) 同理：
  // 没进库的对象留着就是孤儿）
  const render = (error) => {
    if (given) removeFile(given).catch(() => { /* 记过日志了 */ });
    res.status(400).render('score', {
      title: '录入积分',
      season,
      entry: db.findEntry(season.id, req.user.id),
      error,
    });
  };

  if (bad.length) return render('上传凭证无效或已过期，请刷新页面重传');

  const raw = String(req.body.score ?? '').trim();
  if (!/^\d{1,9}$/.test(raw)) return render('积分请填 0 到 999999999 之间的整数');

  const entry = db.getOrCreateEntry(season.id, req.user.id);
  // 截图可选（2026-10-17）：有图就用新的，没带就沿用库里原来那张；
  // 两边都没有就是 NULL —— R4 的 CHECK 已经放宽成"分数/提交时间同生共死"，写得进去。
  const imageName = given || entry.score_image;

  if (given) {
    const { ok, bad: unverified } = await verifyUploaded([given]);
    if (!ok.length) {
      await removeFile(given);
      return render(`截图没传成功（${unverified[0].why}），请重传`);
    }
  }

  // 本人改分或换截图 → 提交时间刷新；分数和截图都没动就保持原时间
  const changed = Number(raw) !== entry.score || !!given;
  const submittedAt = changed || !entry.score_submitted_at
    ? new Date().toISOString()
    : entry.score_submitted_at;

  db.prepare('UPDATE entries SET score=?, score_image=?, score_submitted_at=? WHERE id=?')
    .run(Number(raw), imageName, submittedAt, entry.id);

  // 换图后清掉旧图。**换成了同一张就不删**（回退按钮重发时 given 可能与库里那张相同，
  // 无条件删会把刚提交的这张自己删掉）。
  if (given && entry.score_image && entry.score_image !== given) {
    removeFile(entry.score_image).catch(() => { /* 记过日志了 */ });
  }

  req.session.flash = { type: 'ok', msg: `已提交积分 ${Number(raw)}` };
  res.redirect('/');
});

router.post('/score/withdraw', (req, res) => {
  const season = db.getOpenSeason();
  if (!season) return res.redirect('/');

  const entry = db.findEntry(season.id, req.user.id);
  let keptLineup = false;
  if (entry) {
    // 撤回分之后他这一期就没有名次了，但**阵容还在就算参赛**（2026-10-15 起）——
    // 所以先把这句话要用的信息读出来，再删分（删完再查也能查到，只是顺序上更清楚）。
    keptLineup = db.getLineupImages(entry.id).length > 0;
    db.prepare(`UPDATE entries SET score=NULL, score_image=NULL, score_submitted_at=NULL WHERE id=?`)
      .run(entry.id);
    removeFile(entry.score_image);
  }
  req.session.flash = {
    type: 'ok',
    msg: keptLineup ? '已撤回积分，本期没有名次了（阵容还留着，仍算参赛）' : '已撤回积分，本期没有名次了',
  };
  res.redirect('/');
});

// ---------- 打分（成员互评） ----------
// 和上面的「积分」完全是两回事：积分是本人上传截图的战绩分、决定名次；
// 这里是别人点一下给的评价，只展示。**一期内一个阵容一票，但同一票在截止前随时能改**
// —— 改分没有单独的路由，就是再 POST 一次这个地址（有则 UPDATE、无则 INSERT）。
// 两道时间关：这一期得是进行中，而且还没到截止点（每期开期后第一个周四 12:00 北京，
// 见 db.getRateLockAt）。过了截止整期封盘，连改都不行；要撤掉某条票只能请管理员去 /admin 清。
/* 确认阵容识别的 9 个格子（2026-10-16 加）。
   和打分那条路的区别：**这条不改任何名次、不进结算**，纯粹是玩家对"这张图里是谁"的标注。
   写进 hero_guesses，供阵容卡上做 T0 高亮、以及事后分析识别的准确率。

   表单形状：每格一个字段名 `slot<N>`，值二选一 ——
     · 候选的 key（来源 'pick'）
     · 或者 `__other__`，此时读同名的 `other<N>` 文本框（来源 'other'）
   没提交的格子 = 不动（不是清空）—— 玩家可能只改其中一格就提交了。

   ★ **「其他」只收库里的武将**（2026-10-16 晚用户定的）。文本要能**唯一**对回库里的一条
   （显示名 / name / 唯一前缀，见 db.findHeroesByName），对不上或者有歧义就**不写**，
   并在 flash 里点名说是哪个字没收 —— 否则玩家只会看到"保存了"而那一格没动，像坏了。
   模板那边配合着给了补全列表（lineup-gallery.ejs 的 <datalist>），挑一个必然对得上。

   权限：**本人或管理员**。管理员要能改是因为识别会认错，而玩家不一定回来修。 */
router.post('/entries/:id/heroes', (req, res) => {
  const entry = db.getEntry(Number(req.params.id));
  if (!entry) {
    req.session.flash = { type: 'err', msg: '没有这条记录' };
    return res.redirect('/');
  }
  const me = req.user;
  if (entry.user_id !== me.id && !me.is_admin) return res.status(403).send('不能改别人的识别结果');
  const back = safeReturn(req, '/', entry.season_id) + `#e${entry.id}`;

  // 认的是**哪一张图**，由表单里的 hidden 字段给（卡上摊开的是 images[0]）。
  // ⚠️ 一个 entry 可以有多张阵容图，它们不一定是同一套阵容 ——
  //    从前这里对 entry 的**所有**图一起写，等于把一张图的答案抄给了别的图。
  //    所以必须按 filename 定位，而且**要核这张图真属于这个 entry**（表单是能改的）。
  const files = db.getLineupImages(entry.id).map((i) => i.filename);
  const filename = String(req.body.filename || '');
  if (!files.includes(filename)) {
    req.session.flash = { type: 'err', msg: '这张图不属于这套阵容' };
    return res.redirect(back);
  }

  let saved = 0;
  const rejected = [];                      // 库里对不上的手输（不写库，只在 flash 里点名）
  {
    const known = new Set(db.getGuesses(filename).map((g) => g.slot));
    for (let slot = 1; slot <= 9; slot++) {
      const raw = req.body[`slot${slot}`];
      // 没提交 = 这格没动（单选框一个都没选时，表单不会带这个字段名）。
      // 提了空串 = 玩家点了「不确定」，是**清空**，不是没动 —— 两者必须分开，
      // 否则"取消确认"这个操作永远写不进去。
      if (raw === undefined) continue;
      if (!known.has(slot)) continue;                         // 还没识别过这一格，不认
      if (raw === '') { db.decideGuess(filename, slot, { key: null, source: 'none' }); saved++; continue; }
      if (raw === '__other__') {
        const text = String(req.body[`other${slot}`] || '').trim().slice(0, 40);
        if (!text) continue;
        // ★ 只有**唯一对上库里一条**的名字才收（用户 2026-10-16 晚定的口径：
        //   "只有英雄库中的名字才允许保存"）。从前的做法是对不上也把原文存进 other_name
        //   —— 那是有意的（库里漏了谁、玩家打错了字，都是线索），但代价是卡上会出现
        //   一个既不是候选、也点不开的字符串，而"这套带没带 T0"那行高亮永远亮不起来。
        //   现在两种都**宁可不收**：0 条 = 库里没这个人或打得不像；多条 = 有歧义
        //   （「孙」能命中孙权/孙尚香/孙坚/孙策，findHeroesByName 第三档就是不认这种）。
        //   补全列表给的正是一整条唯一的名字，从里面挑必然过这一关。
        const hits = db.findHeroesByName(text);
        if (hits.length !== 1) { rejected.push(text); continue; }
        // source 仍然是 'other' 而不是 'pick'：统计里"手输"是机器错得最狠的一档
        // （见 db.getRecoStats 的头注释），这个区分要留着。
        db.decideGuess(filename, slot, { key: hits[0].key, source: 'other', otherName: text });
        saved++;
      } else {
        // 只认库里真有的 key。**不信任表单** —— 表单是玩家能随便改的。
        if (!db.getHero(raw)) continue;
        db.decideGuess(filename, slot, { key: raw, source: 'pick' });
        saved++;
      }
    }
  }

  // 被退回的名字要在 flash 里**点名**：只说"有名字没保存"，玩家对着九格找不出来。
  // 去重 + 最多列三个，免得一次提交九格全是生面孔时 flash 撑成一屏。
  const bad = [...new Set(rejected)];
  const badMsg = bad.slice(0, 3).map((t) => `「${t}」`).join('、')
    + (bad.length > 3 ? ` 等 ${bad.length} 个` : '');
  req.session.flash = bad.length
    ? { type: 'err', msg: `${badMsg} 不在武将库里，没保存 —— 从补全列表里挑一个`
        + (saved ? `（另外 ${saved} 处已记下）` : '') }
    : saved
      ? { type: 'ok', msg: `已记下 ${saved} 处` }
      : { type: 'err', msg: '没有改动' };
  res.redirect(back);
});

router.post('/entries/:id/rate', (req, res) => {
  // 跳回墙上的那一次按**投票前的顺序**渲染（见上面的 lineupWall）：投出去的瞬间均分就变了，
  // 顺序跟着变的话，人正在看的那张卡当场跳走。拒绝的分支也置上 —— 被拒的票一个字都没改，
  // 更没理由让墙在眼前重排。用户自己刷新时这个标记早用掉了，按最新的均分重排。
  // 存的是时刻而不是 true：跳回来时还要判"是不是刚投完的那一跳"（见 WALL_HOLD_MS）。
  req.session.wallHold = Date.now();

  const entry = db.getEntry(Number(req.params.id));
  if (!entry) {
    req.session.flash = { type: 'err', msg: '没有这条记录' };
    return res.redirect('/');
  }

  // 回到那张卡，不是回到页顶：阵容墙在排名表下面，跳页顶会让人以为没生效。
  // 卡上有 id="e<id>"（见 partials/lineup-gallery.ejs）。
  const back = safeReturn(req, '/', entry.season_id) + `#e${entry.id}`;

  const season = db.getSeason(entry.season_id);
  if (!season || season.status !== 'open') {
    req.session.flash = { type: 'err', msg: '这一期已经结算了，不能再打分' };
    return res.redirect(back);
  }

  // 封盘。截止的具体时刻在阵容墙上写着（重定向回去就落在墙上），这里只把规矩说清楚，
  // 免得模板里再拼一次时间、多一处格式化的地方。
  if (db.isRateLocked(season)) {
    req.session.flash = {
      type: 'err',
      msg: '本期打分已截止（每期开期后第一个周四 12:00 封盘），不能再投也不能改',
    };
    return res.redirect(back);
  }

  const value = Number(req.body.value);
  if (!db.RATE_VALUES.includes(value)) {
    req.session.flash = { type: 'err', msg: `只能打 ${db.RATE_VALUES.join(' / ')} 这几档` };
    return res.redirect(back);
  }

  if (!db.getLineupImages(entry.id).length) {
    req.session.flash = { type: 'err', msg: '他还没传阵容，不能打分' };
    return res.redirect(back);
  }

  const target = db.getUserById(entry.user_id);
  const had = db.findRating(entry.id, req.user.id);

  // 点的就是原来那一档：一个字都不写。**不能当改分处理** —— 那会白刷一次 created_at，
  // 而 created_at 决定"这个分是谁先给的"（见 getSeasonRatings 的排序），
  // 手滑点一下自己那档、署名就换人了。
  if (had && had.value === value) {
    req.session.flash = { type: 'ok', msg: `你给 ${target.nickname} 打的就是 ${value} 分，没有改动` };
    return res.redirect(back);
  }

  // 名额：400 / 300 / 250 每期每人分别只有 2 / 3 / 4 张，50 和 200 不限（db.RATE_QUOTA）。
  // 改分时这里同样管用，而且不必为"把旧档位的名额退回来"写任何代码 —— 名额是现数的
  // （db.getMyQuota 按 ratings 数），我原来占的那一档不在 value 这一档里，算出来的
  // 就是改完之后的样子。
  // 前端那些灰按钮只是提示，真正拦人的是这里 —— 直接 POST 一个自己已经投满的档位照样被拒。
  // 从这里到下面的写库中间没有 await，better-sqlite3 又全是同步调用，
  // 所以中间插不进另一个请求，不会出现两个并发请求各投一张、合起来超一名额。
  const q = db.getMyQuota(season.id, req.user.id).find((x) => x.value === value);
  if (q && !q.left) {
    req.session.flash = {
      type: 'err',
      msg: `一期内 ${value} 分只有 ${q.quota} 个名额，你已经投满了（50 / 200 不限）`,
    };
    return res.redirect(back);
  }

  if (had) {
    // 改分：更新那一行，并刷新 created_at —— 和「本人改了积分就刷新提交时间」同一套道理，
    // 时间戳说的是这条评价的时间，不是第一次投票的时间。署名问题由上面那个提前 return 挡着：
    // 点自己原来那档不写库，所以这里一定是真的换了档位。
    db.prepare('UPDATE ratings SET value=?, created_at=? WHERE id=?')
      .run(value, new Date().toISOString(), had.id);
    req.session.flash = { type: 'ok', msg: `已把给 ${target.nickname} 的 ${had.value} 分改成 ${value} 分` };
  } else {
    db.prepare('INSERT INTO ratings (entry_id, rater_id, value) VALUES (?, ?, ?)')
      .run(entry.id, req.user.id, value);
    req.session.flash = { type: 'ok', msg: `已给 ${target.nickname} 打 ${value} 分` };
  }
  res.redirect(back);
});

router.get('/ratings', (req, res) => {
  // 进行中、且还没到截止点的期：表里给这些行的票挂一个「去改」的链接，直接跳到那张卡。
  // 别的期（已结算、或已封盘）的票改不了，链接也就不出。
  const season = db.getOpenSeason();
  res.render('ratings', {
    title: '我的打分记录',
    rows: db.getMyRatings(req.user.id),
    canEdit: season && !db.isRateLocked(season) ? season.id : null,
    rateLockAt: season ? db.getRateLockAt(season) : null,
  });
});

// ---------- 历史赛期阵容墙（2026-10-17 加） ----------
// 和首页/游客墙共用 lineup-gallery；这里只是把「某一期」的墙单独开一页，
// 已结算的期也随时能翻回来。canRate 永远是 false —— 打分只在首页进行中的墙上有。
router.get('/seasons/:id/wall', (req, res) => {
  const season = db.getSeason(Number(req.params.id));
  if (!season) return res.status(404).send('没有这一期');
  res.render('season-wall', {
    title: `${season.name} · 阵容墙`,
    season,
    lineups: db.getLineupWall(season.id, req.user.id, null, !!req.user.is_admin),
    byScore: db.isWallByScore(season),
    backTo: `/seasons/${season.id}/wall`,
  });
});

// ---------- 武将索引 / 详情 / 组合检索（2026-10-17 加） ----------
router.get('/heroes', (req, res) => {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  const value = (v) => String(one(v) ?? '').trim();
  const a = value(req.query.a);
  const b = value(req.query.b);
  const c = value(req.query.c);
  const q = value(req.query.q).slice(0, 20);
  const sameUnit = value(req.query.sameUnit) === '1';
  const keys = [a, b, c].filter(Boolean);

  const all = db.getHeroIndex();
  const index = q
    ? all.filter((h) => h.displayName.includes(q) || h.name.includes(q))
    : all;

  res.render('heroes', {
    title: '武将索引',
    index,
    q,
    minSample: db.HERO_MIN_SAMPLE,
    heroes: db.getHeroes(),
    pair: keys.length >= 2
      ? { keys, sameUnit, rows: db.getHeroPairLineups(keys, { sameUnit, viewerId: req.user.id }) }
      : null,
    form: { a, b, c, sameUnit },
  });
});

router.get('/hero/:key', (req, res) => {
  const key = String(req.params.key || '');
  // key 是拼音 slug（zuo_ci / sun_jian2），不是显示名；形状不对直接 404，
  // 不要拿它去查库再拼进任何东西。
  if (!/^[a-z0-9_]{1,40}$/.test(key)) return res.status(404).send('没有这个武将');
  const hero = db.getHero(key);
  if (!hero) return res.status(404).send('没有这个武将');

  res.render('hero', {
    title: `${hero.variant || ''}${hero.name} · 武将`,
    hero,
    stat: db.getHeroIndex().find((h) => h.key === key) || null,
    minSample: db.HERO_MIN_SAMPLE,
    rows: db.getHeroLineups(key, req.user.id),
  });
});

// ---------- 纪录墙（2026-10-17 加） ----------
router.get('/records', (req, res) => {
  const latest = db.prepare(
    `SELECT id FROM seasons WHERE status='settled' ORDER BY id DESC LIMIT 1`).get();
  res.render('records', {
    title: '纪录墙',
    records: db.getRecords(),
    highlights: latest ? db.getSeasonHighlights(latest.id) : null,
    minRaters: db.RECORD_MIN_RATERS,
    minPlays: db.RECORD_MIN_PLAYS,
  });
});

// ---------- 历史 / 详情 / 排行 / 个人 ----------
router.get('/history', (req, res) => {
  res.render('history', { title: '历史赛期', rows: db.getHistory() });
});

router.get('/seasons/:id', (req, res) => {
  const season = db.getSeason(Number(req.params.id));
  if (!season) return res.status(404).send('没有这一期');

  const settled = season.status === 'settled';
  const rows = withImages(settled ? db.getFinalRanking(season.id) : db.getRanking(season.id));
  // 慧眼等级变动榜（只有已结算的期才有内容，模板里也只在 settled 时引它）
  const eye = settled ? db.getEyeAdjustments(season.id) : [];

  res.render('season', {
    title: `${season.name} · 赛期详情`,
    season,
    rows,
    settled,
    eye,
    // 贴群里那段纯文本。**只给已结算的期做**：进行中的期名次还会变，
    // 发出去的"冠军"过两天就成了假消息。没做的时候传 null，模板据此整段不出。
    report: settled
      ? buildReport(season, rows, db.getLineupWall(season.id, null), eye, db.countPlayers(season.id))
      : null,
    notSubmitted: settled ? [] : db.getNotSubmitted(season.id),
    // 参赛 N 人（上传了阵容就算，见 db.countPlayers）· 交分 M 人（有分才有名次）。
    // 两个数都摆出来：只写参赛人数的话，下面那几张战绩卡看着像"只列了一小半"。
    players: db.countPlayers(season.id),
    scored: db.countScored(season.id),
    // 打分截止。进行中的期才摆这一行：已结算的期传 null，模板就不出它。
    // canRate 在这里只用来选措辞（「截止 …」还是「已于 … 截止」）—— 这一页本身没有打分区。
    rateLockAt: settled ? null : db.getRateLockAt(season),
    canRate: !settled && !db.isRateLocked(season),
    // 「看这一期阵容墙」入口只在真有阵容图的时候出（没图的空墙没有可看的）。
    wallCount: db.countLineupEntries(season.id),
    // 「本期之最」只给已结算的期：进行中的最高分/最高均分还会变。
    highlights: settled ? db.getSeasonHighlights(season.id) : null,
  });
});

router.get('/rank', (req, res) => {
  res.render('rank', { title: '总排行榜', board: db.getRankBoard() });
});

router.get('/u/:userId', (req, res) => {
  const u = db.getUserByUid(req.params.userId);
  if (!u) return res.status(404).send('没有这个成员');

  // 近期状态：recent 是「最近 N 个已结算期」倒序，没参加的期也在里面（participated=0）。
  // 连胜从最近一期往前数，遇到没赢/没参加立刻停 —— 不能跳过缺席期把两段连胜接起来。
  const recent = db.getUserRecentForm(u.id);
  let streak = 0;
  for (const r of recent) {
    if (r.is_winner === 1) streak++;
    else break;
  }
  // 较上次交分：只在最近两个有分的已结算期之间算；只有一次交分就留空。
  const scoredRecent = recent.filter((r) => r.score !== null).slice(0, 2);
  const scoreDelta = scoredRecent.length === 2
    ? scoredRecent[0].score - scoredRecent[1].score : null;

  res.render('user', {
    title: `${u.nickname} 的战绩`,
    u,
    stats: db.getUserStats(u.id),
    history: db.getUserHistory(u.id),
    recent,
    streak,
    scoreDelta,
    archive: db.getUserLineupArchive(u.id),
    commonHeroes: db.getUserCommonHeroes(u.id),
  });
});

module.exports = router;
