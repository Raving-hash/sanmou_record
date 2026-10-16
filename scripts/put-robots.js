#!/usr/bin/env node
/* ==========================================================================
   把**图床那份** robots.txt 写进 R2 桶（key 就是 `robots.txt`）。

   为什么它不在 nginx 里、也不在 Node 里：**robots.txt 是按 origin 各管各的**，
   而图床 `img.raving-hash.top` 是 Cloudflare R2 的公开域名 —— 前面没有 nginx，
   也不经过本站那个进程。那个 origin 上唯一能放策略的地方，就是**桶里的一个对象**。
   （站点那份相反，是个普通的 Express 路由，见 routes/public.js。）

   ⚠️ 所以这是**仓库之外的状态**：改了 robots.js 里的 IMAGE 之后必须重跑这个脚本，
      否则线上那份还是旧的。和桶的 CORS 属于同一类东西，DEPLOY.md 里也记了一节。

   ⚠️ 顺带一个坑：Cloudflare 在没有 robots.txt 时会**自动注入**一份 Content Signals
      前言（2026-10-15 实测 1248 字节，**全是注释、一条指令都没有** ⇒ 没有 User-agent
      组 ⇒ 等于没有规则）。我们的对象理应把它盖掉；跑完按打印出来的 curl 复核一次。

   跑法（在**线上目录**跑，那儿的 .env 才有 R2 凭据）：
     cd /home/raving/work/sanmouyanwu
     node --env-file=.env scripts/put-robots.js

   ★ **幂等**：正文和类型都一样就什么都不做 —— 改完 robots.js 直接重跑即可。
   ★ 缓存头**故意不是 putObject 的默认值**（一年 immutable）：策略会变，
     一年缓存等于改不动。这里给 1 小时。
   ========================================================================== */
const r2 = require('../r2');
const { IMAGE } = require('../robots');

const KEY = 'robots.txt';
const TYPE = 'text/plain; charset=utf-8';
const CACHE = 'public, max-age=3600';

// getObject 给的是**流**（备份那种大对象不能整块进内存）。这份才 300 字节，
// 收完再比，省得为"正文是否一致"另立一个判据。
const drain = (res) => new Promise((ok, bad) => {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
  res.on('error', bad);
});

(async () => {
  const body = Buffer.from(IMAGE, 'utf8');
  console.log(`\n桶    ${r2.BUCKET}`);
  console.log(`对象  ${KEY}（本地这份 ${body.length} 字节）\n`);

  const cur = await r2.head(KEY);
  if (cur.exists) {
    const same = (await drain(await r2.getObject(KEY))) === IMAGE;
    if (same && cur.type === TYPE) {
      console.log('正文与类型都对得上 —— 已是最新，什么都不做。');
      console.log(`公开地址 ${r2.publicUrl(KEY)}`);
      return;
    }
    console.log(`桶里那份不一样（现有 ${cur.size} 字节／类型 ${cur.type}）→ 覆盖它`);
  } else {
    console.log('桶里还没有 → 新建');
  }

  const n = await r2.putObject(KEY, body, { type: TYPE, cacheControl: CACHE });

  const after = await r2.head(KEY);
  console.log(`\n写入 ${n} 字节。复核：存在=${after.exists} 大小=${after.size} 类型=${after.type}`);
  console.log(`cache-control  ${after.cacheControl}`);

  console.log(`\n公开地址 ${r2.publicUrl(KEY)}`);
  console.log('请复核这两点（尤其第一次跑）：');
  console.log(`  curl -sI ${r2.publicUrl(KEY)}        # 期望 200 text/plain`);
  console.log(`  curl -s  ${r2.publicUrl(KEY)}        # 期望是我们的正文（含 Disallow: /）`);
  console.log('拿到 1248 字节、全是 "#" 注释的那份，就是没盖掉 Cloudflare 自动注入的前言 ——');
  console.log('退路：去 Cloudflare 面板给这个域配 Content Signals 策略（deploy/DEPLOY.md 里记了）。');
})().catch((e) => { console.error('炸了：', e); process.exit(1); });
