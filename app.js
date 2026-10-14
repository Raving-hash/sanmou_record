const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');
const { UPLOAD_DIR, THUMB_SUFFIX, makeThumb } = require('./upload');

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
    lightbox: assetVer('lightbox.js'),
    comments: assetVer('comments.js'),
    report: assetVer('report.js'),
  };
  // 时间格式化。入参是 ISO 字符串或毫秒时间戳（Date 两种都吃）——
  // 打分截止那种现算出来的时间就是个毫秒数，模板里不用再包一层 new Date()。
  res.locals.fmt = (t) => t
    ? new Date(t).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    : '';
  // 短的日期时间，只有阵容卡下面那条评论在用。fmt 出来是「2026/10/14 14:56」，
  // 塞进 200px 宽的卡里（手机 150px）会把「署名 + 时间 + 删按钮」那一行挤到折行，
  // 所以**当天的只写时分**（「14:56」，和聊天窗口一个习惯），不是当天才带上月日。
  res.locals.fmtShort = (t) => {
    if (!t) return '';
    const d = new Date(t);
    const day = (x) => x.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const hm = d.toLocaleTimeString('zh-CN', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    });
    if (day(d) === day(new Date())) return hm;
    const md = d.toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit' });
    return `${md} ${hm}`;
  };
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
  // 图片的缩略图地址。页面上真正需要原图的地方只有"点开看大图"（lightbox 和
  // <a target="_blank"> 的 href），其余全是小格子 —— 模板里一律写 thumbUrl(名字)，
  // 那几个格子就只下几十 KB 而不是几百 KB（见 upload.js 的缩略图那段）。
  // 命名规则只写在 upload.js 一处，模板不去拼那个后缀，省得将来改了大小对不上。
  res.locals.thumbUrl = (name) => `/uploads/${name}${THUMB_SUFFIX}`;
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
  // 称号（演武王 / 慧眼王）。和慧眼等级同一套路：每请求一张 uid → 称号 的小表，
  // 模板用 titleOf(uid) 取，取不到就是空数组（模板直接 forEach，不用判空）。
  // **全站只有阵容墙引它**（views/partials/title.ejs）—— 这是用户定的显示范围：
  // 称号是排面，阵容墙是唯一"看排面"的地方，别的页面昵称旁已经有慧眼圆框了。
  // 所以这里**懒查**（第一次真被问到才算）：绝大多数请求（每个静态图、每个不渲染阵容墙的页面）
  // 根本用不上它，没必要为一次 GROUP BY 买单 —— 慧眼那张表是每个页面都要，才放在上面直接查。
  let titles = null;
  res.locals.titleOf = (uid) => {
    if (!titles) titles = db.getTitles();
    return titles.get(String(uid ?? '').toLowerCase()) || [];
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

// /uploads 下的图分两类，而且**物理同层**：阵容图和积分截图都是 uploads/<uuid>.jpg，
// URL 空间里分不出谁是谁（那个目录下只有一个点开头的 .incoming，static 不发它）。
// 所以「游客能看阵容图、不能看积分截图」只能逐文件查库：名字在 lineup_images 里就放行，
// 其余（entries.score_image、没人引用的孤儿文件）照旧只有登录能取。
// 用 404 而不是 403 —— 403 等于告诉对方"这里确实有一张积分截图"。
// **不缓存这份白名单**（不做 Set）：有人刚传完阵容就该立刻能看到，一次带索引的微查询
// 在这个量级上直接忽略。
// 注意 req.path 在这个挂载点里已经被 Express 切掉了 /uploads 前缀（只剩一个前导斜杠），
// 完整路径在 req.originalUrl；req.path 也不 decode，所以坏编码要自己兜。
// 「没有这张图」只有这一处出口。no-store 不是可有可无的：404 在 HTTP 里属于
// **可以被启发式缓存**的状态码，游客这次没权限的 404 万一被浏览器记下，
// 他登录之后照样是 404（现在没有 Last-Modified 多半不会发生，但不值得赌）。
const noImage = (res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(404).send('没有这张图');
};

const canSeeUpload = (req, res, next) => {
  if (req.user) return next();                     // 登录了照旧全放行
  let name = req.path.replace(/^\//, '');
  try {
    name = decodeURIComponent(name);
  } catch {
    return noImage(res);                           // 坏的百分号编码（比如 /uploads/%）就是个 404
  }
  // 缩略图认的是它对应的**原图**：/uploads/x.jpg.thumb.jpg 要求 x.jpg 本身在阵容图里。
  // 非认这一下不可 —— 缩略图和原图躺在同一个平铺目录里，积分截图也有缩略图，
  // 不折回原图去查就等于把积分截图的小图一起放出。
  if (name.endsWith(THUMB_SUFFIX)) name = name.slice(0, -THUMB_SUFFIX.length);
  if (!name || /[/\\\0]/.test(name)) return noImage(res);
  if (!db.isLineupImage(name)) return noImage(res);
  next();
};

// 缩略图现补：加这一版之前传的老图没做过缩略图，第一次被要到时现压一张（之后就是普通静态文件）。
// 新图在 upload.js 里上传时就做好了，正常走不到这儿。压不出来就让 static 去 404 ——
// 页面顶多少一张小图，不影响别的。
const ensureThumb = (req, res, next) => {
  const base = path.basename(req.path);
  if (!base.endsWith(THUMB_SUFFIX)) return next();
  const src = base.slice(0, -THUMB_SUFFIX.length);
  if (!src || !fs.existsSync(path.join(UPLOAD_DIR, src))) return next();   // 原图都不在，没什么好压的
  makeThumb(src).then(() => next()).catch((err) => {
    console.error('缩略图生成失败：', base, err.message);
    next();
  });
};

// 图片一律长缓存。文件名是 randomUUID()，一张图写完就永不改（换图 = 换一个新文件名），
// 所以一年 + immutable 是安全的：浏览器连"变了没"都不会再问一次。
// ★ 这一条就是「投完分重刷很慢」的根治。打分是 POST → 302 → 回 /#e<id>，每次都要重刷整页，
//   而从前这里吃的是 express.static 的默认值 max-age=0：页面上十来二十张图，张张都要
//   回服务器问一遍，隧道单程 1.1s —— 实测重刷光这一项 2.3s，几路并发挤在一起时到过 24.6s。
//   改成 immutable 之后，重刷时的图片请求是 0，剩下的只有那一趟 HTML。
// private 而不是 public：同一个 URL 对登录的人 200、对游客 404（积分截图），
// 不能让中间的共享缓存替别人下判断。
// setHeaders 是唯一能改掉这个头的口子：send 先发 headers 事件、再看 Cache-Control
// 有没有被设过，设过就不覆盖（node_modules/send/index.js:854 与 861）。
app.use('/uploads', canSeeUpload, ensureThumb, express.static(UPLOAD_DIR, {
  setHeaders: (res) => res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'),
}), (req, res) => {
  // 末尾那个 404 兜底不能省：白名单放行的名字、磁盘上却没有这张图（换图/删图之后留下的
  // 老链接）时，express.static 会 next() 出去，一路穿到后面的 requireLogin ——
  // 游客于是拿到一个"跳登录页"，而不是一张图的 404。登录的人原本就是 404，两边对齐。
  noImage(res);
});

app.use(require('./routes/auth'));
// 游客可见的那一页 + 评论。**必须挂在 main 前面**：GET / 要先落到它手里，
// 未登录的改道去 /wall、登录了的 next() 落回 main（见 routes/public.js 的头注释）。
app.use(require('./routes/public'));
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
