const bcrypt = require('bcryptjs');
const db = require('../db');
const limiter = require('../limiter');
const router = require('express').Router();

const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));

// ---------- 注册 ----------
router.get('/register', (req, res) => {
  res.render('register', { error: null, form: { code: req.query.code || '', userId: '', nickname: '' } });
});

router.post('/register', (req, res) => {
  const form = {
    code: String(req.body.code || ''),
    userId: String(req.body.userId || '').trim().toLowerCase(),
    nickname: String(req.body.nickname || '').trim(),
  };
  const fail = (error) => res.status(400).render('register', { error, form });

  if (limiter.isLocked(req.ip)) return fail('尝试次数太多，请 15 分钟后再试');

  const real = db.getSetting('invite_code');
  if (!real) return fail('注册暂未开放，请联系管理员');                           // R9
  if (db.normalizeCode(form.code) !== real) {
    limiter.addFail(req.ip);
    return fail('邀请码不正确或已失效');                                          // R8
  }

  if (!/^[a-z0-9_]{3,20}$/.test(form.userId)) return fail('ID 需为 3–20 位小写字母、数字或下划线');
  if ([...form.nickname].length < 1 || [...form.nickname].length > 12)
    return fail('昵称需为 1–12 个字');                                           // R11
  if (db.getUserByUid(form.userId)) return fail('这个 ID 已经被用了，换一个吧');

  const password = String(req.body.password || '');
  const password2 = String(req.body.password2 || '');
  if (password.length < 6) return fail('密码至少 6 位');
  if (password !== password2) return fail('两次输入的密码不一致');

  const info = db.createUser({
    userId: form.userId,
    nickname: form.nickname,
    passwordHash: bcrypt.hashSync(password, 10),
  });

  limiter.clear(req.ip);
  req.session.uid = Number(info.lastInsertRowid);
  req.session.flash = { type: 'ok', msg: `欢迎加入，${form.nickname}！` };
  res.redirect('/');
});

// ---------- 登录 ----------
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: null, form: { userId: '' } });
});

router.post('/login', (req, res) => {
  const form = { userId: String(req.body.userId || '').trim().toLowerCase() };
  const fail = (error) => res.status(400).render('login', { error, form });

  if (limiter.isLocked(req.ip)) return fail('尝试次数太多，请 15 分钟后再试');

  const u = db.getUserByUid(form.userId);
  const ok = u && bcrypt.compareSync(String(req.body.password || ''), u.password_hash);

  if (!ok) {
    limiter.addFail(req.ip);
    return fail('ID 或密码不对');                                                // 不区分，避免探测
  }
  if (u.is_disabled) return fail('这个账号已被禁用，请联系管理员');                 // R12

  limiter.clear(req.ip);
  req.session.uid = u.id;
  res.redirect('/');
});

// ---------- 登出 ----------
router.post('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// ---------- 账号设置（游戏名 + 改密码）----------
router.get('/password', requireLogin, (req, res) => {
  res.render('password', { error: null, ok: false });
});

// 设置游戏名（2026-10-17 加）。游戏里显示的名字和本站昵称不是一回事，
// 而 Windows 端的积分录入接口是按游戏名找人的（见 routes/api.js）。
// 校验（长度 / 重名）在 db.setGameName 里，管理员那条路共用同一份。
// 空提交 = 清掉：还没填的人可以有很多个，但填了就必须唯一。
router.post('/password/game-name', requireLogin, (req, res) => {
  const r = db.setGameName(req.user.id, req.body.game_name);
  req.session.flash = r.ok
    ? { type: 'ok', msg: r.name ? `游戏名已设为「${r.name}」` : '已清除游戏名' }
    : { type: 'err', msg: r.error };
  res.redirect('/password');
});

router.post('/password', requireLogin, (req, res) => {
  const fail = (error) => res.status(400).render('password', { error, ok: false });

  if (!bcrypt.compareSync(String(req.body.old || ''), req.user.password_hash))
    return fail('当前密码不对');

  const next = String(req.body.next || '');
  if (next.length < 6) return fail('新密码至少 6 位');
  if (next !== String(req.body.next2 || '')) return fail('两次输入的新密码不一致');

  db.prepare('UPDATE users SET password_hash=? WHERE id=?')
    .run(bcrypt.hashSync(next, 10), req.user.id);

  req.session.flash = { type: 'ok', msg: '密码已更新' };
  res.redirect('/password');
});

module.exports = router;
