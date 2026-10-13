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
  // 时间格式化。入参是 ISO 字符串或毫秒时间戳（Date 两种都吃）——
  // 打分截止那种现算出来的时间就是个毫秒数，模板里不用再包一层 new Date()。
  res.locals.fmt = (t) => t
    ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '';
  // 还剩多久（打分截止的倒计时）。**精度到小时**：没人关心还剩多少分钟，
  // 但"还剩 3 小时"和"还剩 3 天"完全是两种心情，所以超过一天时把天数一起说出来。
  // 传进来的可能是负数（页面渲染的那一瞬间刚过点），统一说「已截止」。
  res.locals.fmtLeft = (ms) => {
    if (!(ms > 0)) return '已截止';
    const hours = Math.floor(ms / 3600e3);
    if (hours < 1) return `还剩 ${Math.max(1, Math.floor(ms / 60e3))} 分钟`;
    if (hours < 24) return `还剩 ${hours} 小时`;
    const days = Math.floor(hours / 24);
    const rest = hours % 24;
    return rest ? `还剩 ${days} 天 ${rest} 小时` : `还剩 ${days} 天`;
  };
  // 打分的五个档位。唯一真源在 db.js，这里只是让模板能直接 forEach 出按钮
  res.locals.rateValues = db.RATE_VALUES;
  // 「最高 400 由谁打的」这类名单走 views/partials/name-list.ejs —— 从前是这里的一个
  // nameList 助手，加慧眼圆框时挪进了模板：名单要逐个名字拼 HTML，光有字符串不够了。
  // 慧眼等级：所有人初始 10 级，只在结算时按"有没有看准前两名"往上加（只涨不跌，
  // 50 / 200 不再扣，见 db.settleSeason 与 EYE_GAIN）。
  // 昵称出现的地方都要带那个小圆框（views/partials/eye.ejs），但各个列表查出来的字段
  // 五花八门（多数只有一个 uid），所以这里每次请求拉一张 uid → 等级 的小表兜底，
  // 而不是给十处 SQL 各补一列 JOIN。成员就十几个人，代价可以忽略。
  // 查不到这个人返回 null，模板据此**整个不输出**圆框（宁可少一个，也不要空圈）。
  const eyeLevels = db.getEyeLevels();
  res.locals.eyeLevel = (uid) => eyeLevels.get(String(uid ?? '').toLowerCase()) ?? null;
  // 圆框的颜色档位（views/partials/eye.ejs 拿它拼 class，配色写在 style.css 的 .eye-*）：
  // 10–11 暗、12–14 亮银、15–19 亮蓝、20 及以上亮金 —— 越往上越亮，一眼能排出来。
  // 阈值放这儿而不是模板里：圆框被十几处 include，写进模板等于同一串数字抄十几遍。
  // 结算只涨不跌（见 db.js 的 EYE_GAIN），所以低等级只有初始的 10 和刚涨 1 级的 11；
  // 老库里万一手工改出过 10 以下的值，也落这一档。
  res.locals.eyeTier = (lv) => {
    if (lv >= 20) return 'gold';
    if (lv >= 15) return 'blue';
    if (lv >= 12) return 'silver';
    return 'dim';
  };
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
