const db = require('../db');
const { upload, compressUploads, removeFile, removeFiles } = require('../upload');
const router = require('express').Router();

const MAX_LINEUP = Number(process.env.MAX_LINEUP || 6);

// 给排名行挂上各自的阵容截图
const withImages = (rows) => rows.map((r) => ({ ...r, images: db.getLineupImages(r.id) }));

// ---------- 本期看板 ----------
router.get('/', (req, res) => {
  const season = db.getOpenSeason();

  if (season) {
    const entry = db.findEntry(season.id, req.user.id);
    return res.render('home', {
      title: '本期看板',
      season,
      last: null,
      ranking: withImages(db.getRanking(season.id)),
      lineups: db.getLineupWall(season.id, req.user.id),
      // 本期我的打分名额（只含有限额的档位）。阵容墙用它把投满的档位按钮灰掉、
      // 在标题下面列一行"还剩几个"。没在打分的人也会看到，但那是他自己的数，无妨。
      quota: db.getMyQuota(season.id, req.user.id),
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
// 这里是别人点一下给的评价，只展示。一期内对一个阵容只能打一次，打完就不能改
// （要改只能请管理员在 /admin 删掉那条记录）—— 所以这里没有「改分」路由。
router.post('/entries/:id/rate', (req, res) => {
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

  const value = Number(req.body.value);
  if (!db.RATE_VALUES.includes(value)) {
    req.session.flash = { type: 'err', msg: `只能打 ${db.RATE_VALUES.join(' / ')} 这几档` };
    return res.redirect(back);
  }

  if (!db.getLineupImages(entry.id).length) {
    req.session.flash = { type: 'err', msg: '他还没传阵容，不能打分' };
    return res.redirect(back);
  }

  const had = db.findRating(entry.id, req.user.id);
  if (had) {
    req.session.flash = { type: 'err', msg: `你已经给他打过 ${had.value} 了，一期内只能打一次` };
    return res.redirect(back);
  }

  // 名额：400 / 300 / 250 每期每人分别只有 2 / 3 / 4 张，50 和 200 不限（db.RATE_QUOTA）。
  // 放在「你已经投过」后面：两条都撞上时，先说更具体的那条。
  // 前端那些灰按钮只是提示，真正拦人的是这里 —— 直接 POST 一个自己已经投满的档位照样被拒。
  // 从上面那次 SELECT 到这下面的 INSERT 中间没有 await，better-sqlite3 又全是同步调用，
  // 所以中间插不进另一个请求，不会出现两个并发请求各投一张、合起来超一名额。
  const q = db.getMyQuota(season.id, req.user.id).find((x) => x.value === value);
  if (q && !q.left) {
    req.session.flash = {
      type: 'err',
      msg: `一期内 ${value} 分只有 ${q.quota} 个名额，你已经投满了（50 / 200 不限）`,
    };
    return res.redirect(back);
  }

  db.prepare('INSERT INTO ratings (entry_id, rater_id, value) VALUES (?, ?, ?)')
    .run(entry.id, req.user.id, value);

  const target = db.getUserById(entry.user_id);
  req.session.flash = { type: 'ok', msg: `已给 ${target.nickname} 打 ${value} 分` };
  res.redirect(back);
});

router.get('/ratings', (req, res) => {
  res.render('ratings', { title: '我的打分记录', rows: db.getMyRatings(req.user.id) });
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

  res.render('season', {
    title: `${season.name} · 赛期详情`,
    season,
    rows,
    settled,
    // 慧眼等级变动榜（只有已结算的期才有内容，模板里也只在 settled 时引它）
    eye: settled ? db.getEyeAdjustments(season.id) : [],
    notSubmitted: settled ? [] : db.getNotSubmitted(season.id),
    players: db.countPlayers(season.id),
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
