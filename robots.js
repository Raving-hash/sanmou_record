/* ==========================================================================
   反爬虫策略 —— 两份 robots.txt 的**唯一真源**。

   2026-10-15 加。起因是图片搬到 Cloudflare R2 之后全部公开，而全站（含图床）
   **一个有效的 robots.txt 都没有** —— 实测三个 origin 全是"默认允许"的状态：
     · www.raving-hash.top          /robots.txt → 302 到 /login（爬虫拿不到规则）
     · mmm.raving-hash.top:18080    同上（两条入口是同一个 Node 进程）
     · img.raving-hash.top          200，但正文是 Cloudflare 自动注入的 1248 字节
                                    **纯注释**，一条指令都没有 ⇒ 没有 User-agent 组
                                    ⇒ 等于没有规则 ⇒ 默认全允许

   ★ **robots.txt 是按 origin 各管各的**（协议规定：scheme + host + port 才算一个 origin）。
     所以"站点"和"图床"必须**分别**有一份，写一份管不了另一个 —— 这是整件事最容易搞错的地方。
     本站两个页面入口（80 隧道 / 18080 直连）共用同一个 Node 进程，一份就够；
     图床在 Cloudflare R2 上，不经过这个进程，只能作为**桶里的一个对象**存在
     （由 `scripts/put-robots.js` 写上去，那是仓库之外的状态，DEPLOY.md 里记着）。

   ---- 两份的口径为什么相反 ----

   站点：**放行搜索引擎，挡掉 AI 爬虫**（用户 2026-10-15 拍板）。
   图床：**一律不爬**。
   站点能被搜到 ≠ 成员照片该被图片搜索收录 —— 54 张原图进了 Google 图片搜索就会被
   缓存住，撤不回来（DEPLOY.md「安全提醒」第 4 条讲的就是这件事）。
   所以这里**故意不写成同一份**，别为了"统一"把它们合并。

   ---- 两个不要改错的地方 ----

   · 站点那份**故意没有裸的 `Disallow: /`** —— 那是"全站不许爬"，与"放行搜索引擎"
     正好相反。`Disallow: /uploads/` 是为老链接跳转写的（别的意思，见下）。
   · 点名的 UA 与 `Content-Signal` 是**两回事**，都要有：前者是能执行的
     （nginx 也认，见 deploy/nginx-yanwu.conf 的 `$ai_bot`），
     后者只是**声明**（Cloudflare 的 Content Signals 约定），爬虫可以不理。
     两者不重复、不冲突，删任何一个都会少一层。
   ========================================================================== */

// 站点那份。`Disallow: /uploads/` 挡的是**老链接的 302 跳板**（routes/uploads.js）：
// 它不是内容，放爬虫进去只会让它拿着一堆 UUID 去追 302，白烧两边的带宽。
// 其余一律放行 —— 站上真正对游客开放的只有 /wall，其余都要登录（爬虫只会拿到 302）。
const SITE = `# 演武擂台
# 搜索引擎随便来，AI 爬虫一律不许（口径见 robots.js 的头注释）。

User-agent: *
Disallow: /uploads/
Content-Signal: search=yes, ai-input=no, ai-train=no

# ---- AI 爬虫 · 训练类（最该挡的一档）----
User-agent: GPTBot
Disallow: /
User-agent: ClaudeBot
Disallow: /
User-agent: CCBot
Disallow: /
User-agent: Bytespider
Disallow: /
User-agent: meta-externalagent
Disallow: /
User-agent: Amazonbot
Disallow: /
User-agent: cohere-ai
Disallow: /
User-agent: Diffbot
Disallow: /
User-agent: Omgilibot
Disallow: /
User-agent: TimpiBot
Disallow: /
User-agent: AI2Bot
Disallow: /
User-agent: FriendlyCrawler
Disallow: /
User-agent: MistralAI-Index
Disallow: /
User-agent: Google-Extended
Disallow: /
User-agent: Applebot-Extended
Disallow: /

# ---- AI 爬虫 · AI 搜索 / 答案类 ----
User-agent: OAI-SearchBot
Disallow: /
User-agent: PerplexityBot
Disallow: /
User-agent: Claude-SearchBot
Disallow: /
User-agent: DuckAssistBot
Disallow: /
User-agent: MistralAI-User
Disallow: /
# Google 自己有两个 AI 抓取器，与 Googlebot **不是**同一个 UA ——
# 挡它们不会碰到搜索引擎（这正是"放行搜索引擎、挡掉 AI"那条口径的关键）。
# Google-Extended 是训练开关（见上）；GoogleOther / Google-CloudVertexBot 是真会来的 UA。
User-agent: GoogleOther
Disallow: /
User-agent: Google-CloudVertexBot
Disallow: /

# ---- AI 爬虫 · 用户触发类（有人拿 AI 去抓这一页时发的 UA）----
User-agent: ChatGPT-User
Disallow: /
User-agent: Perplexity-User
Disallow: /
User-agent: Claude-User
Disallow: /
User-agent: anthropic-ai
Disallow: /
User-agent: Claude-Web
Disallow: /
`;

// 图床那份。`*` 已经全挡，所以**不需要再点名 AI 爬虫** —— 点名只对"要放行一部分"
// 的场合有意义，这里没有要放行的东西。（别为了"和站点那份对齐"把名单抄过来。）
// 缓存头由 scripts/put-robots.js 设成 1 小时（不是对象默认的一年 immutable）：
// 策略会变，一年缓存等于改不动。
const IMAGE = `# 演武擂台图床 —— 一律不许爬取、不许收录。
# 这份与站点那份**故意不同**：站点可以被搜索引擎收录，图床不行。
# 见 robots.js 的头注释。

User-agent: *
Disallow: /
Content-Signal: search=no, ai-input=no, ai-train=no
`;

module.exports = { SITE, IMAGE };
