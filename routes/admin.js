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
    // 打分还能不能投（每期开期后第一个周四 12:00 封盘，见 db.getRateLockAt）。
    // 管理页两处要用：赛期行上报截止时间，以及"清掉之后他能不能重投"的说法。
    rateLockAt: openSeason ? db.getRateLockAt(openSeason) : null,
    canRate: !!openSeason && !db.isRateLocked(openSeason),
    // 「现在开一期的话，截止会落在什么时候」。截止点是按开期时间算的，周三开期
    // 就只剩一天多 —— 摆在新赛期表单旁边，省得开完了才发现窗口很短。
    nextLockAt: db.getRateLockAt({ created_at: new Date().toISOString() }),
    // 「现在开一期的话，阵容上传要到什么时候才开放」。**必须摆出来**：
    // 上传窗口是"开期后第一个周三 12:00"，所以周三中午之后开期的话，
    // 开放时刻会顺延到下周三 12:00 —— 整整一周谁都不能传阵容。
    // 和上面打分截止是同一个坑，开期前就看得见比开完才发现强。
    nextOpenAt: db.getUploadOpenAt({ created_at: new Date().toISOString() }),
    // 当前这期是不是正卡在"还没到开放时刻"里（开着期却传不了图，管理员得知道为什么）
    uploadClosed: openSeason ? db.isLineupClosed(openSeason) : false,
    uploadOpenAt: openSeason ? db.getUploadOpenAt(openSeason) : null,
    // 阵容识别的效果统计（2026-10-16 加）。用户要的"整理反思"就是这一块：
    // 机器推的头名对不对、正确答案在不在给的三个候选里、玩家手输了哪些库里没有的名字。
    reco: db.getRecoStats(),
    recoEnabled: require('../recognize-worker').enabled(),
    // 视觉模型那一路开着没有。关着的时候上面那些数字会明显难看（没有第二路可比对，
    // 置信度一律 low）—— 页面要说清楚原因，否则管理员会以为识别退化了。
    vlmEnabled: require('../recognize-vlm').enabled(),
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

  // 前置条件数的是**交了积分**的人，不是参赛人数：没交分的人排不出名次，
  // 一期只有 1 个人有分的时候结算出来只有一个胜者，没有意义。
  // （参赛人数是另一个口径 —— 上传了阵容就算，见 db.countPlayers。）
  const scored = db.countScored(season.id);
  if (scored < MIN_PLAYERS) {
    err(req, `只有 ${scored} 人交了积分，少于 ${MIN_PLAYERS} 人不能结算（可以直接删掉这一期）`);
    return res.redirect('/admin');
  }

  const ranking = db.settleSeason(season.id);
  const winners = ranking.slice(0, db.TOP_N);
  const players = db.countPlayers(season.id);
  const eye = db.getEyeAdjustments(season.id);
  // 慧眼等级是结算的副产物，而且是大多数人在页面上唯一能看出"我为什么变了"的地方，
  // 所以在提示里念一遍，免得有人发现自己的等级变了却不知道该问谁。
  // 一个人都没有时要说清是"票不够格"：结算时只有给前两名打 250 分以上才算数
  // （50 / 200 不涨也不跌，见 db.js 的 EYE_GAIN）。
  const eyeTip = eye.length
    ? ` · 慧眼等级：${eye.map((e) => `${e.nickname} ${e.delta > 0 ? '+' : ''}${e.delta}`).join('、')}`
    : ' · 本期没有人的票能加等级，慧眼等级没变';
  // 胜者是前两名（2026-10-15 起），提示里两个人都要念到 —— 只说冠军的话，
  // 管理员看不出这条新规矩生效了没有。正常的期（≥2 人交分）走的是前半句。
  const who = winners.length > 1
    ? `${winners.map((w) => `${w.nickname} ${w.score} 分`).join('、')} 同为胜者`
    : `${winners[0].nickname} 以 ${winners[0].score} 分夺冠`;
  ok(req, `${season.name} 已结算：${who}（共 ${players} 人参赛）${eyeTip}`);
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

router.post('/seasons/:id/delete', async (req, res) => {
  const season = db.getSeason(Number(req.params.id));
  if (!season) { err(req, '没有这一期'); return res.redirect('/admin'); }

  const files = db.collectSeasonFiles(season.id);
  // 已结算的期删掉就当作从没办过，结算时加过的慧眼等级要一起退回来 ——
  // 不退的话，删掉一期会给人留下白拿的等级（eye_adjustments 随 seasons 级联删，
  // 所以必须先退、再删）。
  const reverted = db.revertEye(season.id);
  db.prepare('DELETE FROM seasons WHERE id=?').run(season.id);   // 级联删 entries / lineup_images

  // ★ 这里**必须 await**（全站唯一一处）：下一行那句提示语报了张数，异步的话它就是在撒谎。
  //   而且这是全站最重的一次批量删除（一整期的图，还要连缩略图一起删），
  //   值得让它的失败可见 —— 其余删图的地方都是"删完就重定向"，不 await 是怕拖慢用户。
  const del = await removeFiles(files);

  ok(req, `已删除「${season.name}」，连同 ${files.length} 张图片`
    + (reverted ? `，并退回 ${reverted} 人的慧眼等级` : '')
    + (del.errors.length ? `（⚠ 有 ${del.errors.length} 个对象没删掉，稍后跑一次 r2-gc）` : ''));
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
// 本人的票在**截止前**可以自己改（见 routes/main.js），所以这里主要管两件事：
// 「过了截止想撤掉某条票」和「本人投错了、要重置成没打过」。
// 清掉就是删掉那一行 —— 名额是现数的，当场退回去，不用管别的；
// 但**过了截止他也不能重投**，所以提示里要把这一点说清楚。
router.post('/ratings/:id/delete', (req, res) => {
  const r = db.getRating(Number(req.params.id));
  if (!r) { err(req, '没有这条打分记录'); return res.redirect('/admin'); }

  const entry = db.getEntry(r.entry_id);
  const locked = db.isRateLocked(db.getSeason(entry.season_id));

  db.prepare('DELETE FROM ratings WHERE id=?').run(r.id);
  ok(req, `已清掉 ${r.rater_name} 给 ${r.target_name} 打的 ${r.value} 分`
    + (locked ? '（本期打分已截止，他不能再投）' : '，他可以重新打'));
  res.redirect('/admin');
});

// 上面那条的批量版：整期投乱了、或者想让大家重投一轮时一下清干净。
// 按 :id 圈定赛期而不是"清当前进行中的那一期"：从渲染管理页到点下按钮之间
// 赛期理论上会变（另一处结算 / 撤销结算），带 id 才能保证清的是屏幕上写的那一期。
//
// 只清**进行中**的期。已结算期的记录看起来"没用"（名次早定了），其实两处都有用：
// 慧眼等级是拿它算出来的（`eye_adjustments` 里存着结果），删了记录退不回等级，
// 只会让两边对不上；而且那份记录本身是"当时谁投了谁"的痕迹。
// 要动历史期就照老路先【撤销结算】，它成了进行中的期，自然能清。
router.post('/seasons/:id/ratings/clear', (req, res) => {
  const season = db.getSeason(Number(req.params.id));
  if (!season) { err(req, '没有这一期'); return res.redirect('/admin'); }
  if (season.status !== 'open') {
    err(req, '只能清空进行中的赛期的打分（要动历史期先【撤销结算】）');
    return res.redirect('/admin');
  }

  const n = db.clearSeasonRatings(season.id);
  // 「本来就没有」走 err 而不是 ok：绿色是"干了件事"的意思，这里什么都没干。
  // 正常路径上按钮根本不出（一条票都没有时不渲染），能撞见这条多半是手打地址。
  if (!n) { err(req, `${season.name} 本来就没有打分记录`); return res.redirect('/admin'); }

  // 提示和逐条删一样分两种情况：没过截止谁都能重投，过了就补不回来了 ——
  // 批量删更容易忘掉这件事，所以这里一定要说。
  ok(req, `已清空 ${season.name} 的全部 ${n} 条打分`
    + (db.isRateLocked(season) ? '（本期打分已截止，谁都不能重投了）' : '（本期还没截止，大家都可以重新投）'));
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
