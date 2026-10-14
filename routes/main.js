const db = require('../db');
const { upload, compressUploads, removeFile, removeFiles } = require('../upload');
const router = require('express').Router();

const MAX_LINEUP = Number(process.env.MAX_LINEUP || 6);

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
// rows 是 getFinalRanking 的结果（已结算，**只有交了积分的人**，也就是 R5 说的"参赛"）；
// wall 是 getLineupWall 的结果（已按互评均分降序）；eye 是 getEyeAdjustments 的结果。
const buildReport = (season, rows, wall, eye) => {
  const lines = [`【${season.name} · 演武积分赛】${rows.length} 人参赛`];

  rows.forEach((r, i) => lines.push(`${i ? `${i + 1}. ` : '👑 '}${r.nickname}  ${r.score} 分`));

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
// 平常就是 db.getLineupWall 的默认顺序（互评均分降序）。只有一种例外：**刚从打分 POST
// 跳回来的那一次**，按上一次渲染的顺序原样排一遍 —— 用户 2026-10-14 的口径是
// 「打分以后不动，刷新网页再重排」。投一票会改均分，而均分决定顺序，不冻一下的话
// 整页重刷回来顺序就变了：正在看的卡片当场跳走，还得重新找它在哪。
//
// 那个"上一次的顺序"记在 session 里（一张逗号分隔的 entry id），不是另建表 ——
// 它只活到下一次页面渲染，没有留档的价值。**只生效一次**：读到的同时就把标记删掉，
// 于是用户自己刷新（或者从导航点进来）时按最新的均分重排。
// ⚠️ 顺序对不上期号时一律当没冻过（跨期之后那些 id 也不该再提位置）。
//
// 标记存的是**投出去的时刻**，不是 true：只认"刚投完"的那一跳（5 分钟以内）。投完直接
// 关掉标签页、隔半天才回来的人也走得通 —— 那时旧顺序早没意义了，按最新的均分排才对。
const WALL_HOLD_MS = 5 * 60 * 1000;

const lineupWall = (req, season, viewerId) => {
  const heldAt = Number(req.session.wallHold || 0);
  delete req.session.wallHold;                       // 一次性，用完即清
  const held = heldAt > 0 && Date.now() - heldAt < WALL_HOLD_MS;
  const frozen = held && req.session.wallOrderSeason === season.id
    ? String(req.session.wallOrder || '')
      .split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : [];
  const rows = db.getLineupWall(season.id, viewerId, frozen);

  // 记下这一版的顺序，给"下次投完票跳回来"用。**只在真的变了才赋值**：cookie-session
  // 把整个 session 塞在一张 cookie 里，每赋一次值都要重签一份 Set-Cookie。
  const order = rows.map((r) => r.id).join(',');
  if (req.session.wallOrder !== order || req.session.wallOrderSeason !== season.id) {
    req.session.wallOrder = order;
    req.session.wallOrderSeason = season.id;
  }
  return rows;
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
      lineups: lineupWall(req, season, req.user.id),
      // 本期我的打分名额（只含有限额的档位）。阵容墙用它把投满的档位按钮灰掉、
      // 在标题下面列一行"还剩几个"。没在打分的人也会看到，但那是他自己的数，无妨。
      // 封盘后不查了：那时一个按钮都不出，名额行也就没地方显示。
      quota: canRate ? db.getMyQuota(season.id, req.user.id) : [],
      canRate,
      rateLockAt,
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
    lineups: last ? db.getLineupWall(last.id, req.user.id) : [],
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
  });
});

router.post('/lineup', upload.array('images', MAX_LINEUP), compressUploads, (req, res) => {
  const files = req.files || [];
  const names = files.map((f) => f.filename);

  const season = db.getOpenSeason();
  if (!season) {
    removeFiles(names);
    req.session.flash = { type: 'err', msg: '当前没有进行中的赛期' };
    return res.redirect('/');
  }

  const entry = db.getOrCreateEntry(season.id, req.user.id);
  const existing = db.getLineupImages(entry.id);
  const note = String(req.body.lineup_note || '').trim().slice(0, 1000);

  if (existing.length + names.length > MAX_LINEUP) {
    removeFiles(names);
    req.session.flash = { type: 'err', msg: `阵容截图最多 ${MAX_LINEUP} 张，先删掉几张再传` };
    return res.redirect('/lineup');
  }

  const ins = db.prepare('INSERT INTO lineup_images (entry_id, filename) VALUES (?, ?)');
  db.transaction(() => {
    for (const n of names) ins.run(entry.id, n);
    db.prepare('UPDATE entries SET lineup_note=? WHERE id=?').run(note || null, entry.id);
  })();   // 只改阵容不动 score_submitted_at，提交时间不变

  req.session.flash = {
    type: 'ok',
    msg: names.length ? `已上传 ${names.length} 张阵容截图` : '阵容说明已保存',
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

router.post('/score', upload.single('score_image'), compressUploads, (req, res) => {
  const season = db.getOpenSeason();
  if (!season) {
    if (req.file) removeFile(req.file.filename);
    return res.redirect('/');
  }

  const render = (error) => {
    if (req.file) removeFile(req.file.filename);
    res.status(400).render('score', {
      title: '录入积分',
      season,
      entry: db.findEntry(season.id, req.user.id),
      error,
    });
  };

  const raw = String(req.body.score ?? '').trim();
  if (!/^\d{1,9}$/.test(raw)) return render('积分请填 0 到 999999999 之间的整数');

  const entry = db.getOrCreateEntry(season.id, req.user.id);
  const imageName = req.file ? req.file.filename : entry.score_image;
  if (!imageName) return render('必须上传积分截图才能提交（R4）');

  // 本人改分或换截图 → 提交时间刷新；分数和截图都没动就保持原时间
  const changed = Number(raw) !== entry.score || !!req.file;
  const submittedAt = changed || !entry.score_submitted_at
    ? new Date().toISOString()
    : entry.score_submitted_at;

  db.prepare('UPDATE entries SET score=?, score_image=?, score_submitted_at=? WHERE id=?')
    .run(Number(raw), imageName, submittedAt, entry.id);

  if (req.file && entry.score_image) removeFile(entry.score_image);   // 换图后清掉旧文件

  req.session.flash = { type: 'ok', msg: `已提交积分 ${Number(raw)}` };
  res.redirect('/');
});

router.post('/score/withdraw', (req, res) => {
  const season = db.getOpenSeason();
  if (!season) return res.redirect('/');

  const entry = db.findEntry(season.id, req.user.id);
  if (entry) {
    db.prepare(`UPDATE entries SET score=NULL, score_image=NULL, score_submitted_at=NULL WHERE id=?`)
      .run(entry.id);
    removeFile(entry.score_image);
  }
  req.session.flash = { type: 'ok', msg: '已撤回积分，本期变回「没打」' };
  res.redirect('/');
});

// ---------- 打分（成员互评） ----------
// 和上面的「积分」完全是两回事：积分是本人上传截图的战绩分、决定名次；
// 这里是别人点一下给的评价，只展示。**一期内一个阵容一票，但同一票在截止前随时能改**
// —— 改分没有单独的路由，就是再 POST 一次这个地址（有则 UPDATE、无则 INSERT）。
// 两道时间关：这一期得是进行中，而且还没到截止点（每期开期后第一个周四 12:00 北京，
// 见 db.getRateLockAt）。过了截止整期封盘，连改都不行；要撤掉某条票只能请管理员去 /admin 清。
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
  const back = `/#e${entry.id}`;

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
    report: settled ? buildReport(season, rows, db.getLineupWall(season.id, null), eye) : null,
    notSubmitted: settled ? [] : db.getNotSubmitted(season.id),
    players: db.countPlayers(season.id),
    // 打分截止。进行中的期才摆这一行：已结算的期传 null，模板就不出它。
    // canRate 在这里只用来选措辞（「截止 …」还是「已于 … 截止」）—— 这一页本身没有打分区。
    rateLockAt: settled ? null : db.getRateLockAt(season),
    canRate: !settled && !db.isRateLocked(season),
  });
});

router.get('/rank', (req, res) => {
  res.render('rank', { title: '总排行榜', board: db.getRankBoard() });
});

router.get('/u/:userId', (req, res) => {
  const u = db.getUserByUid(req.params.userId);
  if (!u) return res.status(404).send('没有这个成员');
  res.render('user', {
    title: `${u.nickname} 的战绩`,
    u,
    stats: db.getUserStats(u.id),
    history: db.getUserHistory(u.id),
  });
});

module.exports = router;
