const db = require('../db');
const limiter = require('../limiter');
const robots = require('../robots');
const router = require('express').Router();

// ---------- 游客能看的那一点点（全站唯一的免登录入口） ----------
// 全站默认是「不登录什么都看不了」：routes/main.js 整条挂在 requireLogin 后面。
// 这个文件是**唯一**的例外，所以它故意长得很小 —— 游客只能看阵容墙（含每套阵容下的评论）、
// 以及下面那份 robots.txt，
// 排名表、积分、积分截图、「还没交积分」名单、成员页、历史、总排行、上传、打分
// 一条都没放出来（用户定的口径：只能参观公布的阵容）。
//
// 挂载顺序有讲究：必须在 routes/main.js **前面**（见 app.js）。
// 这样 GET / 先落到这里：没登录的就地改道去 /wall，登录了的 next() 落回 main 的完整看板 ——
// 于是 views/home.ejs 一行都不用改，不必在里面长出游客分支。

// 交给用户看的那句话（flash）+ 回到刚才那张卡。**req.session 可能是 null**：
// app.js 每请求都会重新查用户，发现被封禁就把 session 置空（cookie-session 的 getter
// 会把这一整个请求的 req.session 都返回 null，不只是这一行）—— 而被封禁的人恰好是
// 未登录状态来发评论的，public 这边没有 requireLogin 兜着，直接写 .flash 就是 TypeError。
// routes/main.js 里可以随手写 req.session.flash，是因为那儿 req.user 一定存在。
const flash = (req, type, msg) => {
  if (req.session) req.session.flash = { type, msg };
};

// 回跳目标。发完/删完都要落回**那张卡**（PRG），别让人以为没生效 —— 和打分路由一样。
// 成员可能在首页的墙上看，游客只可能在 /wall 上看，所以模板里带一个 hidden 的 back。
// 白名单判定，不拿它拼任意地址。
const backTo = (req, entryId) =>
  (req.body.back === 'wall' ? '/wall' : '/') + (entryId ? `#e${entryId}` : '');

// 正文：把连续空白折成一个空格再 trim。只 trim 不够 —— 一串全角空格（　，\s 认它）
// 也能凑出一个"看起来是空的 20 个字"。
const cleanText = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// 20 字按 JS 的 String.length 算，和输入框上的 maxlength="20" 是**同一个口径**，
// 所以不会出现"浏览器让你打字、服务端嫌长"。中文一个字算 1，一个 emoji 算 2。
const MAX_TEXT = 20;

// 跨站提交兜底。评论是全站唯一一个**不需要登录就能写**的接口：它没有 session 可以挂
// CSRF token，sameSite=lax 也拦不住"游客的第一次提交"（那本来就没有 cookie 可发）。
// 浏览器一定会带 Origin（新浏览器还有 Sec-Fetch-Site），别人网页里的一段自动提交代码躲不过；
// curl / 测试脚本两者都没有 → 放行，因为威胁模型里的"坏人"是别人网页里的 JS，不是命令行。
// **只比 hostname**：nginx 的 `proxy_set_header Host $host` 不带端口，
// 按"host 完全相等"比会把走端口访问的游客全部拒掉。
const crossSite = (req) => {
  const site = req.get('sec-fetch-site');
  if (site) return site === 'cross-site';
  const src = req.get('origin') || req.get('referer');
  if (!src) return false;
  try {
    return new URL(src).hostname !== req.hostname;
  } catch {
    return true;              // 解析不出来的 Origin 一律当跨站
  }
};

// ---------- 看 ----------

// GET /robots.txt —— 爬虫策略，正文在 robots.js（唯一真源）。
// ★ **必须留在这个文件里**，也就是 requireLogin **之前**：挂到后面会变成 302 到
//   /login，而爬虫拿不到 robots.txt 时的默认是"全允许" —— 那正是 2026-10-15 之前
//   的状态（实测三条入口一个有效的 robots.txt 都没有）。
// 这里只服务**站点**这一份。图床 `img.raving-hash.top` 是另一个 origin、不经过这个
// 进程，它那份只能作为 R2 桶里的对象存在（scripts/put-robots.js 写上去）。
router.get('/robots.txt', (req, res) => res.type('text/plain').send(robots.SITE));

// GET / —— 没登录的人的首页就是阵容墙。登录了的交给 main（那是完整的看板）。
router.get('/', (req, res, next) => (req.user ? next() : res.redirect('/wall')));

// GET /wall —— 公开版首页：只有阵容墙（含评论），没有排名表、没有积分、没有上传入口。
// 成员也能来（和 GET /login 那种"登录了就回首页"不同）：`canRate:false` 让打分按钮不出，
// 于是一个入口就同时是"游客看到的样子"——管理员想核对自己开放了什么，不用退出登录。
router.get('/wall', (req, res) => {
  const season = db.getOpenSeason();
  const shown = season || db.getLastSeason();   // 没有进行中的期 → 摆最近一个已结算的
  res.render('wall', {
    title: '阵容墙',
    season,
    last: season ? null : shown || null,
    // viewerId 传 null：这套视图里没有"我打过多少分"这回事，
    // summarizeRatings 里 `r.rater_id === null` 恒假，mine 自然是 null。
    lineups: shown ? db.getLineupWall(shown.id, null) : [],
  });
});

// ---------- 写 ----------

// 发表评论。游客和成员共用这一条，靠 req.user 区分署名（游客一律「游客」）。
// 校验顺序：跨站 → 有没有这套阵容 → 他传没传阵容 → 正文 → 限流，
// 每一步都是 flash + 302 回那张卡。
router.post('/entries/:id/comments', (req, res) => {
  if (crossSite(req)) return res.status(403).send('跨站提交被拒绝');

  const entry = db.getEntry(Number(req.params.id));
  if (!entry) {
    flash(req, 'err', '没有这套阵容');
    return res.redirect(backTo(req, null));
  }

  const back = backTo(req, entry.id);

  // 没传阵容 = 墙上根本没有他的卡，评论发出去谁也不会看到 —— 和打分同一道关
  // （routes/main.js 的「他还没传阵容，不能打分」）。
  if (!db.getLineupImages(entry.id).length) {
    flash(req, 'err', '他还没传阵容，不能评论');
    return res.redirect(back);
  }

  const text = cleanText(req.body.text);
  if (!text) {
    flash(req, 'err', '评论不能是空的');
    return res.redirect(back);
  }
  if (text.length > MAX_TEXT) {
    flash(req, 'err', `最多 ${MAX_TEXT} 个字（这条 ${text.length} 个）`);
    return res.redirect(back);
  }

  // 限流只拦游客：成员有身份、有人盯着，而且不少成员共用一个出口 IP，按 IP 限他们
  // 等于连坐。**只在真的写进库之后才记一次**（见 limiter.js），
  // 所以打错字、超长被拒都不会吃掉额度。
  if (!req.user) {
    const wait = limiter.guestCommentWait(req.ip);
    if (wait) {
      flash(req, 'err', wait);
      return res.redirect(back);
    }
  }

  db.addComment(entry.id, req.user ? req.user.id : null, text);
  if (!req.user) limiter.noteGuestComment(req.ip);
  flash(req, 'ok', req.user ? '评论已发表' : '已以「游客」的身份发表');
  res.redirect(back);
});

// 删一条评论。谁能删：管理员（任意一条）+ 成员（自己发的）。游客发的 user_id 是 NULL，
// 所以只有管理员删得掉 —— 游客没有身份，也就没有"本人"这回事。
// ⚠️ 必须先取 req.user 再判：写成 `req.user?.is_admin || c.user_id === req.user.id`
// 在未登录时会对 null 取 .id 直接抛 TypeError，而"未登录来删"恰恰是最该返回 403 的那条路径
// —— 而且这条路由没有 requireLogin 兜着，所以 500 是真实可达的。
router.post('/comments/:id/delete', (req, res) => {
  const me = req.user;

  // 没登录的一律 403 —— **包括"这条评论根本不存在"的情形**（所以资格判定在查库之前）：
  // 反过来的话，外人就能拿 403 和 302 的差别去问"这个 id 存不存在"。
  if (!me) return res.status(403).send('不能删这条评论');

  const c = db.getComment(Number(req.params.id));
  if (!c) {
    flash(req, 'err', '这条评论已经不在了');
    return res.redirect(backTo(req, null));
  }

  // 管理员删任意一条；成员删自己发的。游客发的 user_id 是 NULL，所以只有管理员删得掉
  // —— 游客没有身份，也就没有"本人"这回事。
  // （这里能直接写 me.id 是因为上面已经把 me 为空的情形挡掉了。）
  if (!(me.is_admin || c.user_id === me.id)) return res.status(403).send('不能删这条评论');

  db.deleteComment(c.id);
  flash(req, 'ok', '评论已删除');
  res.redirect(backTo(req, c.entry_id));
});

module.exports = router;
