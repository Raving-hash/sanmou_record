const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const { removeFiles } = require('../upload');
const router = require('express').Router();

const MIN_PLAYERS = 2;
const SCORE_RE = /^\d{1,9}$/;

const ok = (req, msg) => { req.session.flash = { type: 'ok', msg }; };
const err = (req, msg) => { req.session.flash = { type: 'err', msg }; };

// ---------- 管理页 ----------
router.get('/', (req, res) => {
  const openSeason = db.getOpenSeason();
  res.render('admin', {
    title: '管理',
    origin: `${req.protocol}://${req.get('host')}`,
    invite: db.getSetting('invite_code'),
    seasons: db.getHistory(),
    users: db.listUsers(),
    openSeason,
    // 打分只能在进行中的期产生，所以只列这一期就够了：要清历史期的先把那一期
    // 【撤销结算】，它就成了进行中的期，记录自然会出现在这儿。
    seasonRatings: openSeason ? db.listSeasonRatings(openSeason.id) : [],
  });
});

// ---------- 赛期 ----------
router.post('/seasons', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 40);
  if (!name) { err(req, '期名不能为空'); return res.redirect('/admin'); }
  if (db.getOpenSeason()) { err(req, '已经有一期在进行中了，先结束它'); return res.redirect('/admin'); }

  db.prepare(`INSERT INTO seasons (name) VALUES (?)`).run(name);
  ok(req, `已创建「${name}」`);
  res.redirect('/admin');
});

router.post('/seasons/:id/settle', (req, res) => {
  const season = db.getSeason(Number(req.params.id));
  if (!season) { err(req, '没有这一期'); return res.redirect('/admin'); }
  if (season.status !== 'open') { err(req, '这一期已经结算过了'); return res.redirect('/admin'); }

  const players = db.countPlayers(season.id);
  if (players < MIN_PLAYERS) {
    err(req, `只有 ${players} 人交了积分，少于 ${MIN_PLAYERS} 人不能结算（可以直接删掉这一期）`);
    return res.redirect('/admin');
  }

  const ranking = db.settleSeason(season.id);
  const w = ranking[0];
  const eye = db.getEyeAdjustments(season.id);
  // 慧眼等级是结算的副产物，而且是大多数人在页面上唯一能看出"我为什么变了"的地方，
  // 所以在提示里念一遍，免得有人发现自己的等级变了却不知道该问谁。
  const eyeTip = eye.length
    ? ` · 慧眼等级：${eye.map((e) => `${e.nickname} ${e.delta > 0 ? '+' : ''}${e.delta}`).join('、')}`
    : ' · 本期没人给前两名打分，慧眼等级没变';
  ok(req, `${season.name} 已结算：${w.nickname} 以 ${w.score} 分夺冠（共 ${players} 人参赛）${eyeTip}`);
  res.redirect(`/seasons/${season.id}`);
});

router.post('/seasons/:id/reopen', (req, res) => {
  const season = db.getSeason(Number(req.params.id));
  if (!season) { err(req, '没有这一期'); return res.redirect('/admin'); }
  if (season.status !== 'settled') { err(req, '这一期还没结算'); return res.redirect('/admin'); }
  if (db.getOpenSeason()) { err(req, '先结束当前进行中的那一期，才能撤销这一期的结算'); return res.redirect('/admin'); }

  db.reopenSeason(season.id);
  ok(req, `${season.name} 已撤销结算，改完记得重新结算`);
  res.redirect(`/seasons/${season.id}`);
});

router.post('/seasons/:id/delete', (req, res) => {
  const season = db.getSeason(Number(req.params.id));
  if (!season) { err(req, '没有这一期'); return res.redirect('/admin'); }

  const files = db.collectSeasonFiles(season.id);
  // 已结算的期删掉就当作从没办过，结算时加过的慧眼等级要一起退回来 ——
  // 不退的话，删掉一期会给人留下白拿的等级（eye_adjustments 随 seasons 级联删，
  // 所以必须先退、再删）。
  const reverted = db.revertEye(season.id);
  db.prepare('DELETE FROM seasons WHERE id=?').run(season.id);   // 级联删 entries / lineup_images
  removeFiles(files);

  ok(req, `已删除「${season.name}」，连同 ${files.length} 张图片`
    + (reverted ? `，并退回 ${reverted} 人的慧眼等级` : ''));
  res.redirect('/admin');
});

// ---------- 修正别人的积分（不刷新提交时间） ----------
router.post('/entries/:id', (req, res) => {
  const entry = db.getEntry(Number(req.params.id));
  if (!entry) { err(req, '没有这条记录'); return res.redirect('/admin'); }

  const season = db.getSeason(entry.season_id);
  const back = `/seasons/${entry.season_id}`;

  if (season.status !== 'open') { err(req, '只能修正进行中的赛期'); return res.redirect(back); }
  if (entry.score === null) { err(req, '这个人还没交积分，得他本人上传积分截图才能录分'); return res.redirect(back); }

  const raw = String(req.body.score ?? '').trim();
  if (!SCORE_RE.test(raw)) { err(req, '积分请填 0 到 999999999 之间的整数'); return res.redirect(back); }

  // 只改分数，score_submitted_at 保持不动
  db.prepare('UPDATE entries SET score=? WHERE id=?').run(Number(raw), entry.id);
  ok(req, `已把积分修正为 ${Number(raw)}（提交时间不变）`);
  res.redirect(back);
});

// ---------- 清除打分 ----------
// 打分是一锤子买卖（UNIQUE(entry_id, rater_id)），点错了本人改不了，只能从这里删。
// 删掉之后那个阵容对他重新变成「没打过」，可以再打一次。
router.post('/ratings/:id/delete', (req, res) => {
  const r = db.getRating(Number(req.params.id));
  if (!r) { err(req, '没有这条打分记录'); return res.redirect('/admin'); }

  db.prepare('DELETE FROM ratings WHERE id=?').run(r.id);
  ok(req, `已清掉 ${r.rater_name} 给 ${r.target_name} 打的 ${r.value} 分，他可以重新打`);
  res.redirect('/admin');
});

// ---------- 邀请码 ----------
router.post('/invite/regenerate', (req, res) => {
  const code = db.genInviteCode();
  ok(req, `新邀请码：${code}（旧码立刻失效，注册已开放）`);
  res.redirect('/admin');
});

router.post('/invite/close', (req, res) => {
  db.setSetting('invite_code', '');
  ok(req, '注册已关闭，任何人都无法再用邀请码注册');
  res.redirect('/admin');
});

// ---------- 成员 ----------
router.post('/users/:id/toggle', (req, res) => {
  const u = db.getUserById(Number(req.params.id));
  if (!u) { err(req, '没有这个成员'); return res.redirect('/admin'); }
  if (u.id === req.user.id) { err(req, '不能禁用自己'); return res.redirect('/admin'); }

  db.prepare('UPDATE users SET is_disabled=? WHERE id=?').run(u.is_disabled ? 0 : 1, u.id);
  ok(req, u.is_disabled ? `已启用 ${u.nickname}` : `已禁用 ${u.nickname}（他会被强制退出，历史战绩保留）`);
  res.redirect('/admin');
});

router.post('/users/:id/reset', (req, res) => {
  const u = db.getUserById(Number(req.params.id));
  if (!u) { err(req, '没有这个成员'); return res.redirect('/admin'); }

  // 去掉容易看错的字符，方便口头转达
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
  const temp = Array.from(crypto.randomBytes(8), (b) => ALPHA[b % ALPHA.length]).join('');

  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 10), u.id);
  ok(req, `${u.nickname} 的临时密码是 ${temp} —— 请尽快转告本人并让他自己改掉`);
  res.redirect('/admin');
});

module.exports = router;
