const express = require('express');
const db = require('../db');
const limiter = require('../limiter');
const r2 = require('../r2');
const {
  MAX_LINEUP, MAX_OUT_BYTES, PUT_HEADERS, THUMB_SUFFIX,
  mintKey, issueToken, isKey, IMG_BASE,
} = require('../upload');

const router = express.Router();

/* ==========================================================================
   图片相关的 HTTP 面，就两条路由：

     POST /uploads/sign    发上传令牌（浏览器拿着它直传 R2，字节不过这台机器）
     GET  /uploads/:name   老链接的 302 跳板

   ★ 这个路由**挂在 requireLogin 之前**（见 app.js 的挂载顺序），两个理由：
     · 老链接 302 不需要登录 —— 从前 /uploads 对游客是"逐文件放行阵容图"，
       现在图全公开了（用户拍板的取舍），谁拿着老地址都该被送过去；
     · sign 需要登录，但它要回的是 **401 JSON 而不是 302 到 /login**。
       挂在 requireLogin 后面的话，前端 `fetch` 拿到的是登录页的 HTML，
       `res.json()` 当场抛错，用户只能看到一句"未知错误"。
   ========================================================================== */

/* ---------- 发上传令牌 ----------
   前端**先把它要传的图全压好**，再调这里要令牌（见 public/upload.js）。
   顺序不能反：老手机压 6 张可能好几分钟，先签名的话令牌有效期会被压缩吃掉。

   `count` 是这一批要传几张。**服务端按 count 预检配额**，而不是等提交时才发现超了 ——
   不然用户会白压白传一批注定被拒的图（那批字节走的是他自己的流量和 R2 的带宽）。 */
router.post('/uploads/sign', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: '登录状态已过期，请刷新页面重新登录' });

  const kind = String(req.body.kind || 'lineup');
  const count = Number(req.body.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_LINEUP) {
    return res.status(400).json({ error: '一次只能传一张' });
  }

  const season = db.getOpenSeason();
  if (!season) return res.status(409).json({ error: '当前没有进行中的赛期' });

  if (kind === 'lineup') {
    // 上传窗口（2026-10-18 改口径）。**和 POST /lineup 那一道是同一件事**，
    // 只是提前到签名这一步 —— 不提前拦的话，玩家会白压白传一批注定被拒的图
    // （那批字节走的是他自己的流量和 R2 的带宽）。
    // 周二 12:00 起先传初步图；周三 12:00 起完整图可以覆盖初步图，所以那种时候
    // 手里有初步图**不算占名额**（真正拦人的 POST 那一道会删旧图再入库）。
    const phase = db.getUploadPhase(season);
    if (phase === 'closed') {
      return res.status(409).json({
        error: `阵容要到 ${res.locals.fmt(db.getUploadOpenAt(season))} 才开放上传`,
      });
    }
    // 用 findEntry 而不是 getOrCreateEntry：这里只是在**预检**，不该因为人家点了
    // 一次"选择文件"就先在库里给他建一条空记录（提交时才建，和从前的时机一致）。
    const entry = db.findEntry(season.id, req.user.id);
    const imgs = entry ? db.getLineupImages(entry.id) : [];
    const occupied = phase === 'preliminary'
      ? imgs.length
      : imgs.filter((i) => !i.is_preliminary).length;
    if (occupied + count > MAX_LINEUP) {
      return res.status(409).json({
        error: phase === 'preliminary'
          ? '每期只能传一张阵容图，要换请先删掉现在这张'
          : '每期只能传一张完整阵容图，要换请先删掉现在这张',
      });
    }
  }

  // 配额预检挡的是"本期额度"，挡不住反复 sign 又不提交 —— 那道闸门在这里。
  const wait = limiter.signWait(req.user.id, count);
  if (wait) return res.status(429).json({ error: wait });

  try {
    const items = [];
    for (let i = 0; i < count; i++) {
      const key = mintKey();
      items.push({
        key,
        thumbKey: key + THUMB_SUFFIX,
        url: r2.presignPut(key, PUT_HEADERS),
        thumbUrl: r2.presignPut(key + THUMB_SUFFIX, PUT_HEADERS),
        // 头由**服务端下发**、前端原样回传。它们是签进签名里的，两边一旦不一致
        // 就是 403 SignatureDoesNotMatch —— 让它只有一处真源，就没有"漂移"这回事。
        headers: PUT_HEADERS,
        token: issueToken(req.user.id, key),
      });
    }
    limiter.noteSign(req.user.id, count);
    res.json({ items, maxBytes: MAX_OUT_BYTES });
  } catch (e) {
    // 签名本身不走网络（纯 crypto），走到这儿多半是配置坏了。别让页面炸成 500 白屏，
    // 回一句能看懂的 —— 前端会把它显示出来且**不提交表单**（图不会丢在客户端）。
    console.error('签发上传令牌失败：', e.message);
    res.status(503).json({ error: '图片服务暂时不可用，稍后再试（图片还在你手上，没丢）' });
  }
});

/* ---------- 老链接的 302 跳板 ----------
   改造前图片的地址是 `/uploads/<名字>`，页面上、别人的收藏夹里都留了一批。
   现在图片在 R2 上，这里把老地址送过去，省得那些链接一律 404。

   ★ 用 **302 不用 301**：deploy/DEPLOY.md 里记着"301 会被浏览器**永久**记住"的教训。
     老链接是过渡期的东西，将来图片域名换了还得能改。
   ★ 放在 Node 里而不是 nginx：不用引入第二份图片域名（nginx 里硬编码 = 两处真源，
     与"URL 拼接归 Node"相悖）、不用 sudo + reload、两个入口自动都覆盖。
     代价是这一跳过隧道（约 1.1s），但它只服务老书签。
   ★ 判据用 upload.js 的 isKey（严格 UUID 形状）而**不是**"以 /uploads/ 开头就弹走" ——
     否则 `/uploads/随便什么` 都会被弹到图片域名上，等于给了一个半开放的跳转口。
     形状对不上直接 404，和从前"没有这张图"一个口径。 */
router.get('/uploads/:name', (req, res) => {
  const name = req.params.name;
  const base = name.endsWith(THUMB_SUFFIX) ? name.slice(0, -THUMB_SUFFIX.length) : name;
  if (!isKey(base)) return res.status(404).send('没有这张图');
  res.redirect(302, `${IMG_BASE}/${name}`);
});

/* ---------- 末尾的 404 兜底（**不能省**）----------
   `/uploads/` 空名字、`/uploads/.incoming/x.jpg` 这种多一层的路径，都匹配不上
   `:name`（Express 的 `:name` 只吃一段），于是会**穿过这个路由**一路抵达后面的
   requireLogin —— 游客拿到的是一张"跳登录页"，而不是 404。老代码末尾那个兜底
   就是为这件事写的，搬家时容易漏。

   `/uploads` 下其余一切到这里就结束：没有这张图。 */
router.use('/uploads', (req, res) => res.status(404).send('没有这张图'));

module.exports = router;
