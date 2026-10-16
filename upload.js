const crypto = require('crypto');
const r2 = require('./r2');

/* ==========================================================================
   图片的**命名 / 签名 / 删除策略**。（出网那一层在 r2.js，这里只管规矩。）

   2026-10-15 起图片存在 Cloudflare R2 上，**由浏览器直传**，后端不再经手字节。
   于是从前"multer 收字节 → sharp 压到 <1MB → 落 uploads/"那条流水线整体没了，
   压缩和缩略图都搬到 public/upload.js（浏览器里用 canvas 做）。

   这个文件仍然存在的理由，是保住从前那两条不变量（它们跟"图存在哪"无关）：
     · **命名规则只有一处** —— 模板、lightbox、删除、迁移脚本都从这里取；
     · **删图必须连缩略图一起删** —— 漏了就在桶里积一堆没人引用的 .thumb.jpg。

   命名沿用改造前的：`<uuid>.jpg` 与它的 `<uuid>.jpg.thumb.jpg`。
   ★ 后缀为什么接在原名**后面**（`x.jpg.thumb.jpg`）而不是中缀（`x.thumb.jpg`）：
     中缀反推不回原图（`x.thumb.jpg` 切掉后缀剩 `x`，分不出 `.jpg` 还是 `.png`），
     而老链接的 302 与全站的 thumbUrl 都要靠"切掉后缀折回原图"。
     更要紧的是：**桶上已经躺着 58 个按这个规则命名的对象**（迁移时一个字节没改名），
     所以这个规则现在是硬约束，不是可以顺手改掉的风格问题。
   ========================================================================== */

const THUMB_SUFFIX = '.thumb.jpg';

// 单张图（压完）的体积上限。原来是服务端 sharp 保证的，现在由**浏览器**保证
// （public/upload.js 压到 ≤ 这个值才发），服务端拿到 key 之后用 HeadObject 复核。
// 两处必须一致 —— 所以它从这里出，由 /uploads/sign 随响应下发给前端。
const MAX_OUT_BYTES = Number(process.env.MAX_OUT_BYTES || 1024 * 1024);

// 每人每期的阵容图上限。从前 routes/main.js 里有一份、app.js 的 locals 里又有一份，
// 现在收到这里一处。
//
// ⚠️ 2026-10-16 起**写死 1**（用户定的设定："只允许上传一张阵容图"）。
//    刻意**不再从 env 读** —— 它已经从"部署旋钮"变成产品规则了，留在 .env 里
//    dev 和线上会悄悄分家；更要命的是线上 .env 是手工维护的，
//    改了代码不改线上等于没改（`DS_API_KEY` 同理）。改上限就改这一行。
const MAX_LINEUP = 1;

// 签名令牌的有效期。只需覆盖"压缩 + 上传"这一段（前端是**先全压完再签名**，
// 所以这期间不夹着几分钟的客户端压缩），10 分钟很宽裕。
const SIGN_TTL = Number(process.env.SIGN_TTL || 600);

// 对象上的类型与缓存头。**必须在 PUT 的那一刻写进对象元数据** —— R2 不会自己加，
// 而从前那条 `private, max-age=31536000, immutable` 是 app.js 现盖的（现在那层没了）。
// 不写进去 = 浏览器拿到 R2 的默认策略，README 里量过的"重刷时图片请求是 0"当场回归
// （20 张图逐张回问要 2.3s，并发挤一起实测到过 24.6s）。
// public 而不是 private：图片现在对所有人一视同仁，不再有"积分截图只有登录能看"。
// ★ 这两个头还要**签进 presigned URL 的签名头**里（routes/uploads.js 调 presignPut 时
//   传的就是它），否则客户端能改 —— 尤其 content-type 不签的话，别人可以拿这张 URL
//   往图片域名上传一个 text/html，**在自己的域名下挂钓鱼页**。
const IMG_TYPE = 'image/jpeg';
const CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PUT_HEADERS = { 'Content-Type': IMG_TYPE, 'Cache-Control': CACHE_CONTROL };

if (!process.env.SESSION_SECRET) throw new Error('缺少 SESSION_SECRET，请检查 .env');

/* ---------- 命名与 URL ---------- */

// 图片的公开域名（.env 的 R2_PUBLIC_BASE_URL；r2.js 已经保证它存在）。
// **全站拼图片 URL 的唯一出口**：模板里的 imgUrl/thumbUrl、老链接的 302 都走这里。
const IMG_BASE = r2.PUBLIC_BASE;
const imgUrl = (name) => `${IMG_BASE}/${name}`;
const thumbUrl = (name) => `${IMG_BASE}/${name}${THUMB_SUFFIX}`;

// 造一个新的 key。**必须由服务端造**，两个理由：
//   ① 本站是纯 HTTP（用户硬性要求，见 README），浏览器里没有 secure context，
//      `crypto.randomUUID()` 压根是 undefined；
//   ② 服务端要能认出"这个名字是我刚发出去的"（见下面的令牌）。
const mintKey = () => crypto.randomUUID() + '.jpg';

/* ---------- 令牌：证明"这个 key 是我刚发给你的" ----------

   ★ 这一层**不是**在防"猜 UUID"，是在堵一条真实的越权删除路径。
     站上所有阵容图 URL 都是**公开的**（游客可见的阵容墙上就渲染着，见
     views/partials/lineup-gallery.ejs），所以**别人的 key 是公开信息，不用猜**。
     而没有令牌时：
       甲把乙的 key 提交进自己的阵容 → 再删掉那一条 → removeFile(乙的 key)
       → **乙的图被删掉**，而乙库里还留着一条指向空对象的记录。
     `lineup_images.filename` 没有 UNIQUE 约束（schema.sql）、删图时无条件
     removeFile，所以这条路是通的。`/score` + 撤回同构，删赛期时还会连坐。
     结论：必须有"这个名字是不是**我**刚从**这台服务器**领到的"校验。

   为什么不做成服务端的一张 pending 表：session 用的是 cookie-session，
   **整个 session 存在签名 cookie 里**（app.js），把十几个 UUID 塞进去会撑爆 4KB。
   所以走无状态 HMAC，复用已有的 SESSION_SECRET，不新增存储、不新增依赖。

   为什么**逐 key 签**而不是整批签一个：6 张里有 1 张解码失败时，逐 key 允许
   提交剩下 5 张；整批签则一张失败整批失效。也天然扛重复提交。 */
const sigOf = (uid, key, exp) => crypto
  .createHmac('sha256', process.env.SESSION_SECRET)
  .update(`${uid}|${key}|${exp}`)
  .digest('hex')
  .slice(0, 32);

// 发给前端的令牌串（放进隐藏 input 的值里）。key 里不含 `|`，用它分隔是安全的。
const issueToken = (uid, key) => {
  const exp = Math.floor(Date.now() / 1000) + SIGN_TTL;
  return `${key}|${exp}|${sigOf(uid, key, exp)}`;
};

// key 的形状。**先卡形状再比签名，顺序不能反** —— 形状这关挡掉带 `/`、带 NUL 之类的
// 怪东西，不让它们进到后面的比较里。它同时是"老链接 302"那条路由的判据。
const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;
const isKey = (s) => typeof s === 'string' && KEY_RE.test(s);

// 校验一条令牌，通过返回 key，否则 null
function checkToken(uid, token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('|');
  if (parts.length !== 3) return null;
  const [key, expStr, sig] = parts;
  if (!isKey(key)) return null;
  const exp = Number(expStr);
  if (!Number.isInteger(exp) || exp < Math.floor(Date.now() / 1000)) return null;
  const want = sigOf(uid, key, exp);
  // timingSafeEqual 要求等长；长度不等直接判否（长度本身不是秘密）
  if (sig.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want))) return null;
  return key;
}

/* 从表单里读出一批令牌。Express 的 urlencoded 解析下重复字段名给出数组
   （`images=a&images=b`）。返回 { keys, bad }：keys 是**校验通过且去重**的，
   bad 是没通过的（调用方据此报错，别静默丢弃）。

   `field` 由模板决定：/lineup 用 `images`，/score 用 `image_key`。 */
function readKeys(req, field) {
  const raw = req.body ? req.body[field] : null;
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw]);
  const keys = [];
  const bad = [];
  for (const t of list) {
    const k = checkToken(req.user && req.user.id, t);
    if (k) { if (!keys.includes(k)) keys.push(k); } else bad.push(String(t).slice(0, 60));
  }
  return { keys, bad };
}

/* ---------- 删除 ----------
   语义与改造前完全一致（**名字和签名都没变**，所以 routes/ 下的调用点几乎不用改）：
   删一个名字，连它的缩略图一起删；对象不存在也不报错。

   改成异步了：删的是**远端对象**，不像从前 unlinkSync 那样微秒级返回。
   大多数调用点是"删完就去重定向"，不该被一次出网请求拖住，所以调用方**不 await**、
   失败只记日志（删除幂等，漏一次还有 r2-gc 兜底）。
   唯一例外是 routes/admin.js 删整个赛期那条 —— 它下面那句提示语报了张数，
   必须 await 才不算撒谎。 */
// 一个名字 → 它实际对应的**全部**对象（原图，以及不是缩略图时再加一个缩略图）。
// 两处唯一的差别就是这个展开规则，所以抽出来，别在 removeFile/removeFiles 里各写一遍。
function expand(names) {
  const list = [];
  for (const n of names || []) {
    if (!n) continue;
    const base = String(n).replace(/^.*\//, '');   // 防手滑传进来一个路径
    list.push(base);
    if (!base.endsWith(THUMB_SUFFIX)) list.push(base + THUMB_SUFFIX);
  }
  return [...new Set(list)];
}

async function deleteKeys(keys) {
  if (!keys.length) return { deleted: [], errors: [] };
  try {
    const r = await r2.removeKeys(keys);
    if (r.errors.length) console.error('删图失败：', r.errors.join('、'));
    return r;
  } catch (e) {
    console.error('删图出错：', keys.join('、'), e.message);
    return { deleted: [], errors: [e.message] };
  }
}

const removeFile = (name) => deleteKeys(name ? expand([name]) : []);
const removeFiles = (names) => deleteKeys(expand(names));

module.exports = {
  THUMB_SUFFIX, MAX_OUT_BYTES, MAX_LINEUP, SIGN_TTL,
  IMG_TYPE, CACHE_CONTROL, PUT_HEADERS,
  IMG_BASE, imgUrl, thumbUrl, mintKey,
  issueToken, checkToken, readKeys, isKey,
  removeFile, removeFiles,
};
