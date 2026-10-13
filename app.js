const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');
const { UPLOAD_DIR } = require('./upload');

if (!process.env.SESSION_SECRET) throw new Error('缺少 SESSION_SECRET，请检查 .env');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);                    // 前面有 Nginx 时，req.ip 才是真实 IP

app.use(express.urlencoded({ extended: false }));
app.use(cookieSession({
  name: 'sess',
  secret: process.env.SESSION_SECRET,
  maxAge: 30 * 864e5,                         // 30 天
  sameSite: 'lax',
  httpOnly: true,
}));

// 每次请求都重新查用户：禁用后马上生效（R12）
app.use((req, res, next) => {
  const u = req.session.uid ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.uid) : null;
  if (u && u.is_disabled) req.session = null;
  req.user = u && !u.is_disabled ? u : null;
  res.locals.me = req.user;
  res.locals.path = req.path;
  res.locals.assetVer = {
    pico: assetVer('pico.min.css'),
    style: assetVer('style.css'),
    upload: assetVer('upload.js'),
  };
  res.locals.fmt = (iso) => iso
    ? new Date(iso).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '';
  // 打分的五个档位。唯一真源在 db.js，这里只是让模板能直接 forEach 出按钮
  res.locals.rateValues = db.RATE_VALUES;
  // 「最高 400 由谁打的」这类名单。截前两个，再多就「等 N 人」——
  // 只有五档，并列很常见，全摊在 200px 的卡上会占三行。
  res.locals.nameList = (list) => list.slice(0, 2).map((x) => x.nickname).join('、')
    + (list.length > 2 ? ` 等 ${list.length} 人` : '');
  // 慧眼等级：所有人初始 10 级，只在结算时按"有没有看准前两名"加减（见 db.settleSeason）。
  // 昵称出现的地方都要带那个小圆框（views/partials/eye.ejs），但各个列表查出来的字段
  // 五花八门（多数只有一个 uid），所以这里每次请求拉一张 uid → 等级 的小表兜底，
  // 而不是给十处 SQL 各补一列 JOIN。成员就十几个人，代价可以忽略。
  // 查不到这个人返回 null，模板据此**整个不输出**圆框（宁可少一个，也不要空圈）。
  const eyeLevels = db.getEyeLevels();
  res.locals.eyeLevel = (uid) => eyeLevels.get(String(uid ?? '').toLowerCase()) ?? null;
  // 一次性提示（重定向后显示）
  res.locals.flash = req.session ? req.session.flash || null : null;
  if (req.session) delete req.session.flash;
  next();
});

const PUBLIC_DIR = path.join(__dirname, 'public');
// /public/ 下每个静态资源的版本号 = 文件 mtime。nginx 给 /public/ 盖了 max-age=604800，
// 不带版本号的话改完 style.css / upload.js 浏览器一周都不会来取新的（得让用户按 Ctrl+Shift+R）。
// 每请求 statSync 几次的开销可以忽略，换来的是改完刷新即生效。
const assetVer = (f) => {
  try { return Math.round(fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs); } catch { return 0; }
};

const requireLogin = (req, res, next) => (req.user ? next() : res.redirect('/login'));
const requireAdmin = (req, res, next) => (req.user?.is_admin ? next() : res.status(403).send('无权限'));

app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/uploads', requireLogin, express.static(UPLOAD_DIR));   // 登录后才能看图

app.use(require('./routes/auth'));
app.use('/admin', requireLogin, requireAdmin, require('./routes/admin'));
app.use(requireLogin, require('./routes/main'));

// 统一错误处理
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).send('图片不能超过 10MB');
  if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).send('一次最多上传 6 张');
  console.error(err);
  res.status(400).send(err.message || '出错了');
});

const port = process.env.PORT || 3000;
// HOST=127.0.0.1 时只监听回环，外部一律经 nginx 进来（.env 里已设）
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => console.log(`演武擂台已启动：http://${host}:${port}`));
