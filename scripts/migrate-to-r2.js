#!/usr/bin/env node
/* ==========================================================================
   把本地 uploads/ 里的图搬到 R2。**幂等，可反复跑**（先跑一遍，cutover 前再补一遍增量）。

   跑法：
     node --env-file=.env scripts/migrate-to-r2.js                 # 预演（默认，什么都不写）
     node --env-file=.env scripts/migrate-to-r2.js --apply         # 真写
     node --env-file=.env scripts/migrate-to-r2.js --apply --db <线上库> --from <线上 uploads>

   ★ `--db` 与 `--from` 默认都是**相对路径**（./data/app.db、./uploads），
     **故意不写死线上绝对路径** —— 这个仓库是公开的，带 `/home/raving/...` 的字符串
     一进仓库就等于把本机目录结构公开（README 里那几处是历史遗留，别再添新的）。
     实际搬运时在命令行上指到线上：
       --db /home/raving/work/sanmouyanwu/data/app.db --from /home/raving/work/sanmouyanwu/uploads
     ★ 两个都要指线上：**字节的真源是线上 uploads/**（开发目录那份是某次 pull 的快照，
       可能缺图或多图），而"该有哪些"的真源是**线上库**。在开发目录里跑默认值
       只会搬开发目录那一份，不是我们要的。

   ★ 默认 dry-run 是沿用 scripts/recompress.js 的既有约定（README 里写过
     「先不加 --apply 看清单」）。搬迁这种动作默认预演。

   ★ **一个本地文件都不删**。uploads/ 是回滚底座：R2 上出任何问题，代码退回去就完事了。
     而且 cutover 之后新传的图**只在 R2 上**，回滚前必须先把它们拉回来
     （那个是 scripts/r2-pull.js 的活）。要删本地也得等备份验过、回滚演练做过，
     至少留一个月。

   为什么要拿 DB 当参照：本地目录里可能有没人引用的孤儿（实测有一个
   `<uuid>.jpg.thumb.jpg.thumb.jpg`，是早期 makeThumb 的 bug 产物），
   而 DB 里也可能有文件名指向已经不存在的本地文件（换图删旧文件时的竞态）。
   两边都打印出来，别默默吞掉。
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const r2 = require('../r2');
const { dbRefs } = require('./r2-refs');

const ROOT = path.join(__dirname, '..');
const THUMB_SUFFIX = '.thumb.jpg';
const APPLY = process.argv.includes('--apply');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DB_PATH = arg('--db', path.join(ROOT, 'data', 'app.db'));
const LOCAL = arg('--from', path.join(ROOT, 'uploads'));

// 早期 makeThumb 的 bug 遗留：拿一个缩略图去生成缩略图。它不在 DB 里引用，
// 也不该搬到 R2 —— 搬上去就是给公开域名加一个没人要的对象。
const BUGGY_ORPHAN = /\.thumb\.jpg\.thumb\.jpg$/;

const isThumb = (n) => n.endsWith(THUMB_SUFFIX);

async function main() {
  console.log(`\n本地 ${LOCAL}`);
  console.log(`库   ${DB_PATH}（只读）`);
  console.log(`桶   ${r2.BUCKET} ／ ${r2.ENDPOINT}`);
  console.log(APPLY ? '\n模式 **真写**\n' : '\n模式 预演（加 --apply 才真写）\n');

  const local = fs.existsSync(LOCAL)
    ? fs.readdirSync(LOCAL).filter((f) => !f.startsWith('.'))
    : [];
  const localSet = new Set(local);
  const need = dbRefs(DB_PATH);   // 引用集的唯一真源在 scripts/r2-refs.js（迁移/GC/备份共用）

  const buggy = local.filter((f) => BUGGY_ORPHAN.test(f));
  const orphans = local.filter((f) => !need.has(f) && !BUGGY_ORPHAN.test(f));
  const missing = [...need].filter((f) => !localSet.has(f));

  console.log(`本地文件 ${local.length} 个（其中 bug 孤儿 ${buggy.length} 个，跳过）`);
  console.log(`库引用   ${need.size} 个（原图 + 推出来的缩略图）`);
  if (buggy.length) console.log(`  · 跳过 bug 孤儿：${buggy.join('、')}`);
  if (orphans.length) console.log(`  · 本地有、库里没人引用（**不搬**）：${orphans.join('、')}`);
  if (missing.length) {
    console.log(`  · ⚠ 库里有、本地却没有 ${missing.length} 个 —— 搬完这几个在 R2 上仍是空的：`);
    console.log(`    ${missing.join('、')}`);
  }

  // 要搬的就是"库里引用、本地也有"的那批
  const todo = [...need].filter((f) => localSet.has(f)).sort();
  console.log(`\n待处理 ${todo.length} 个\n`);

  let uploaded = 0, skipped = 0, failed = 0, bytes = 0;
  for (let i = 0; i < todo.length; i++) {
    const key = todo[i];
    const full = path.join(LOCAL, key);
    const size = fs.statSync(full).size;
    const tag = `[${String(i + 1).padStart(3)}/${todo.length}]`;

    try {
      // 幂等：同名同大小就跳过（跑两遍不该重复传，第二遍应该秒过）
      const h = await r2.head(key);
      if (h.exists && h.size === size) {
        skipped++;
        console.log(`${tag} 已在，跳过  ${key}`);
        continue;
      }
      if (APPLY) {
        await r2.putObject(key, fs.readFileSync(full));
        const after = await r2.head(key);
        if (!after.exists || after.size !== size) throw new Error(`复核不过：写进去 ${after.size}，本地 ${size}`);
        uploaded++; bytes += size;
        console.log(`${tag} 已上传  ${key}  ${size}B`);
      } else {
        uploaded++; bytes += size;
        console.log(`${tag} 将上传  ${key}  ${size}B`);
      }
    } catch (e) {
      failed++;
      console.log(`${tag} ✗ 失败  ${key}  ${e.message}`);
    }
  }

  console.log(`\n${APPLY ? '已上传' : '将上传'} ${uploaded} ／ 跳过 ${skipped} ／ 失败 ${failed}`
    + `  ·  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
  if (!APPLY) console.log('\n（这是预演，什么都没写。确认无误后加 --apply）');
  if (failed) process.exitCode = 1;
}

main().catch((e) => { console.error('炸了：', e); process.exit(1); });
