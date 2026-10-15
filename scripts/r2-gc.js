#!/usr/bin/env node
/* ==========================================================================
   回收**没人引用的对象**（孤儿）。

   为什么现在才有这个需求：改造前"每一条删除路径都调 removeFile"，所以不积孤儿。
   改成浏览器直传之后，多出三条新的丢弃路径：
     · PUT 成功了，但表单没提交（关标签页、按了返回、改主意了）；
     · PUT 成功了，但服务端复核不过（体积超了 / 缩略图没上去）被打回；
     · 一批里前面几张成功、后面失败。
   不回收的话桶只会慢慢涨。

   跑法：
     node --env-file=.env scripts/r2-gc.js                  # 预演（默认）
     node --env-file=.env scripts/r2-gc.js --apply          # 真删
     node --env-file=.env scripts/r2-gc.js --db <线上库> --hours 1 --apply

   ★ **默认预演**。删对象是不可逆的，而且这个脚本的判据是"不在我的库里 = 垃圾" ——
     判据本身很危险（见下面那条防线），所以默认只打印。

   ★★ 两条防线，都别拆：
     ① **只碰长得像本站 key 的对象**（`<uuid>.jpg` / `<uuid>.jpg.thumb.jpg`）。
        桶是共享过一次的（RealOrSteal 的 `捡漏拍卖行-图标-600.png` 和 `images/`
        曾经躺在里面，是用户手动清掉的）。"列出整个桶、减掉我的库、剩下的删掉"
        这种写法会把别人的数据删光。长相不对的一律**只报告、不删**。
     ② **宽限期**：只删 N 小时（默认 24）以前的对象。用户可能正开着上传页、
        压了好几张还没点提交 —— 那些对象此刻正是"没被引用"的，不该被当成垃圾。

   为什么不做成自动跑（cron）：删除是破坏性的，而这个脚本的判据依赖"库是完整的"。
   库没损坏、备份也在的时候，手动跑一次最稳。真要挂定时，先用 --hours 调大 +
   重定向输出留档，别直接 --apply。
   ========================================================================== */
const path = require('path');
const r2 = require('../r2');
const { dbRefs } = require('./r2-refs');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const DB_PATH = arg('--db', path.join(ROOT, 'data', 'app.db'));
const HOURS = Number(arg('--hours', 24));

// 本站的 key 长相。**故意只认这一种**：认不出的（老命名、别人的对象、
// 文件夹占位对象）一律只报告不删 —— 宁可漏收，不可误删。
const OURS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg(\.thumb\.jpg)?$/;

(async () => {
  console.log(`\n库   ${DB_PATH}（只读）`);
  console.log(`桶   ${r2.BUCKET}`);
  console.log(`宽限 ${HOURS} 小时 ／ ${APPLY ? '模式 **真删**' : '模式 预演（加 --apply 才删）'}\n`);

  const refs = dbRefs(DB_PATH);
  const objects = await r2.listAll();
  const cutoff = Date.now() - HOURS * 3600e3;

  const dead = [];       // 归档：没被引用、形状对、也过了宽限期
  const recent = [];     // 没被引用，但还新（可能是正在上传的）
  const foreign = [];    // 形状不对 —— 不是本站的，一根手指都不碰

  for (const o of objects) {
    if (refs.has(o.key)) continue;
    if (!OURS.test(o.key)) { foreign.push(o.key); continue; }
    const t = Date.parse(o.lastModified);
    (Number.isFinite(t) && t < cutoff ? dead : recent).push(o.key);
  }

  console.log(`桶内对象 ${objects.length} ／ 库引用 ${refs.size}`);
  console.log(`  可回收 ${dead.length}`);
  console.log(`  还新、先留着 ${recent.length}`);
  if (foreign.length) {
    console.log(`  ⚠ 形状不像本站的 ${foreign.length} 个（**不动**）：${foreign.slice(0, 5).join('、')}`);
  }
  if (dead.length) console.log(`\n清单：\n${dead.map((k) => '  ' + k).join('\n')}`);

  if (!APPLY) {
    console.log('\n（这是预演，什么都没删。确认清单无误后加 --apply）');
    return;
  }
  if (!dead.length) { console.log('\n没有可回收的。'); return; }

  const r = await r2.removeKeys(dead);
  console.log(`\n删掉 ${r.deleted.length} 个${r.errors.length ? `，失败 ${r.errors.length} 个：${r.errors.join('、')}` : ''}`);
  if (r.errors.length) process.exitCode = 1;
})().catch((e) => { console.error('炸了：', e); process.exit(1); });
