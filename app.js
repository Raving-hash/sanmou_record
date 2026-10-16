const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieSession = require('cookie-session');
const db = require('./db');
const { imgUrl, thumbUrl, IMG_BASE, MAX_OUT_BYTES } = require('./upload');

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
    wall: assetVer('wall.js'),
    comments: assetVer('comments.js'),
    report: assetVer('report.js'),
    reco: assetVer('reco.js'),
    // 站点图标（2026-10-16 加）。三份都是 scripts/make-icon.js 生成后提交进仓库的，
    // 页面只引用、运行时不生成；引用方式见 partials/header.ejs。
    icon: assetVer('icon.svg'),
    ico: assetVer('favicon.ico'),
    touch: assetVer('apple-touch-icon.png'),
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
  // 图片地址。页面上真正需要原图的地方只有"点开看大图"（lightbox 和
  // <a target="_blank"> 的 href），其余全是小格子 —— 模板里一律写 thumbUrl(名字)，
  // 那几个格子就只下几十 KB 而不是几百 KB。
  //
  // ★ 2026-10-15 起这两个助手返回的是**跨域的绝对地址**（Cloudflare R2 的公开域名），
  //   不再是站内的 `/uploads/…`。命名规则与域名都只写在 upload.js / .env 一处。
  // ★ `href` 与同一条上的 `data-shots` **必须都走 imgUrl** —— lightbox 要靠逐字节
  //   相等在组里定位当前这张（public/lightbox.js），一个相对一个绝对就会出幻影「1/2」。
  // ★ imgBase 是给 lightbox 判前缀用的（模板写到 <html data-img-base>），
  //   这样 JS 里也不用硬编码域名。
  res.locals.imgUrl = imgUrl;
  res.locals.thumbUrl = thumbUrl;
  res.locals.imgBase = IMG_BASE;
  // 单张压完后的体积上限。给模板渲染进表单的 data-upload-max-bytes ——
  // 浏览器要先知道这个数才好在本地压到合适（服务端提交时还会 HEAD 复核一遍）。
  // 从 upload.js 取而不是在模板里写死：改一处就够。
  res.locals.maxOutBytes = MAX_OUT_BYTES;
  // 打分的五个档位。唯一真源在 db.js，这里只是让模板能直接 forEach 出按钮
  res.locals.rateValues = db.RATE_VALUES;
  // 「前两名」这个数（结算时算赢 / 慧眼等级认的人 / 墙上描边，见 db.js 的 TOP_N）。
  // 模板里凡是要判"这行算不算胜者"的地方都读它，别在模板里写死 2 ——
  // 用户 2026-10-15 改的就是这个数，写死的话下次改规矩得满页面找。
  res.locals.topN = db.TOP_N;
  // 这个武将 key 在不在 T0 名单里（阵容卡上的高亮用，见 partials/reco.ejs）。
  // 名单本体是 db.js 的 T0_HEROES —— 单一真源，改动只改那一处。
  res.locals.isT0 = db.isT0;
  // 武将库的显示名（variant + name），给「其他」输入框的补全名单用
  // （views/partials/lineup-gallery.ejs 的 <datalist>）。**拼法和候选按钮上印的、
  // 以及服务端反查用的那个字符串逐字一样**（db.findHeroesByName 的第一档就是它）——
  // 补全里挑一个存下去必然能对上库，这三处不能各写各的。
  // **故意不缓存**：heroes 表每次启动都从 herodata/index.json 重播，测试里还会自己 seed
  // 一份（.devlocal/test/test-heroes.js），缓存住的话模板看到的是上一份名单。
  // 102 行一次全表扫描，和 isT0 一样是每请求算，代价可以忽略。
  res.locals.heroNames = db.getHeroes().map((h) => (h.variant || '') + h.name);
  // 「最高 400 由谁打的」那个名字走 views/partials/name-list.ejs —— 从前是这里的一个
  // nameList 助手，加慧眼圆框时挪进了模板：要拼「昵称 + 圆框」的 HTML，光有字符串不够了。
  // （2026-10-14 起它只印并列里的第一个名字，库里给的照样是全部的人。）
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

// 图片相关的那两条路由（发上传令牌 / 老链接 302）。**必须挂在 requireLogin 之前** ——
// sign 要回的是 401 JSON 而不是登录页的 HTML，老链接也不该要登录（图现在全公开）。
// 详见 routes/uploads.js 的头注释。
app.use(require('./routes/uploads'));

app.use(require('./routes/auth'));
// 游客可见的那一页 + 评论。**必须挂在 main 前面**：GET / 要先落到它手里，
// 未登录的改道去 /wall、登录了的 next() 落回 main（见 routes/public.js 的头注释）。
app.use(require('./routes/public'));
app.use('/admin', requireLogin, requireAdmin, require('./routes/admin'));
app.use(requireLogin, require('./routes/main'));

// 统一错误处理
// （从前这里映射 multer 的 LIMIT_FILE_SIZE / LIMIT_UNEXPECTED_FILE —— 图片直传之后
//   字节不再经过这个进程，那两条已经没有来源了。体积和类型的把关现在在
//   routes/uploads.js 的 sign + 提交时的 HeadObject 复核两处。）
app.use((err, req, res, next) => {
  console.error(err);
  res.status(400).send(err.message || '出错了');
});

// 阵容识别的后台队列（2026-10-16 加）。**必须在 listen 之前起** ——
// 它的 sweep() 要扫一遍库里没识别过的阵容图（进程重启会把内存队列清空）。
// 单进程 + setInterval(...).unref()，和 limiter.js 同一套路，不引入任何队列依赖。
// herodata/ 不在时它自己会安静地不启用（沙箱就靠这条隔离，见 .devlocal/test/reset.sh）。
require('./recognize-worker').start();

const port = process.env.PORT || 3000;
// HOST=127.0.0.1 时只监听回环，外部一律经 nginx 进来（.env 里已设）
const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => console.log(`演武擂台已启动：http://${host}:${port}`));
