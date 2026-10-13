#!/usr/bin/env node
// 把 uploads/ 里「压图功能上线之前」传的老图补压一遍，对齐 upload.js 的 <1MB 标准。
//
//   npm run recompress            # 预演：只报告会做什么，一个字节都不动
//   npm run recompress -- --apply # 真改
//
// 新上传的图在 upload.js 的 compressUploads 里已经自动压过了，所以这个脚本
// 通常只在两种情况下用得上：从旧备份恢复了一份还没压过的 uploads/，
// 或者改了压缩阶梯想按新标准重跑一遍。
//
// 改动是不可逆的（原图被更小的重编码版替换掉）。跑之前先 `npm run backup`。

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { compressOne, UPLOAD_DIR, MAX_OUT_BYTES } = require('../upload');

const APPLY = process.argv.includes('--apply');
const ROOT = path.join(__dirname, '..');
const kb = (b) => (b / 1024).toFixed(0) + 'KB';

// 数据库里被引用着的所有图片文件名，连同它挂在哪张表上（改名字时要一起更新）
const refs = [
  ...db.prepare('SELECT id, filename AS name FROM lineup_images').all()
    .map((r) => ({ table: 'lineup_images', id: r.id, name: r.name })),
  ...db.prepare('SELECT id, score_image AS name FROM entries WHERE score_image IS NOT NULL').all()
    .map((r) => ({ table: 'entries', id: r.id, name: r.name })),
];

// 按文件名归并：同一个文件可能被多处引用，改名时要一次性全改掉
const byName = new Map();
for (const r of refs) {
  if (!byName.has(r.name)) byName.set(r.name, []);
  byName.get(r.name).push(r);
}

// 一条引用的改名语句 + 一句删旧文件，都塞进一个事务里做，要么全成要么全不动
const RENAME_SQL = {
  lineup_images: 'UPDATE lineup_images SET filename=? WHERE id=?',
  entries: 'UPDATE entries SET score_image=? WHERE id=?',
};

(async () => {
  console.log(`\n演武擂台 · 老图补压${APPLY ? '' : '（预演，不会动任何文件）'}\n`);

  let done = 0, pending = 0, skipped = 0, missing = 0, failed = 0;
  let bytesBefore = 0, bytesAfter = 0;

  // 快照成数组再遍历：循环里要往 valid 里加改名后的新名字，
  // 直接在 Map 上迭代的话新条目会被同一次循环再访问一遍。
  const entries = [...byName];
  const valid = new Set(byName.keys());

  for (const [name, rows] of entries) {
    const src = path.join(UPLOAD_DIR, name);

    let before;
    try {
      before = (await fsp.stat(src)).size;
    } catch {
      console.log(`  ?  ${name}  —— 数据库里有引用，但文件不在 uploads/，跳过`);
      missing++;
      continue;
    }

    // 已经是压缩标准内的 jpg 就不动了
    if (name.endsWith('.jpg') && before <= MAX_OUT_BYTES) {
      console.log(`  ·  ${name}  ${kb(before)} —— 已达标，跳过`);
      bytesBefore += before; bytesAfter += before;
      skipped++;
      continue;
    }

    const finalName = name.replace(/\.[^.]+$/, '') + '.jpg';

    if (!APPLY) {
      console.log(`  →  ${name}  ${kb(before)} —— 会被压成 ${finalName}`);
      bytesBefore += before;
      pending++;
      continue;
    }

    // 先压到一个谁也不认识的名字，再原子 rename 到目标名。
    // 直接写目标名的话，万一中途出错就把人家原图毁在半截。
    const tmpName = 'rc-' + crypto.randomUUID() + '.jpg';
    try {
      const after = await compressOne(src, tmpName);
      await fsp.rename(path.join(UPLOAD_DIR, tmpName), path.join(UPLOAD_DIR, finalName));

      // 改名（.png → .jpg 这种情况）时数据库引用要跟着换，和补压放同一个事务
      if (finalName !== name) {
        db.transaction(() => {
          for (const r of rows) db.prepare(RENAME_SQL[r.table]).run(finalName, r.id);
        })();
      }
      if (finalName !== name) {
        await fsp.rm(src, { force: true });
        // 改名后新名字也算「被引用」，否则最后那句孤儿检查会把它误报出来
        valid.delete(name);
        valid.add(finalName);
      }

      console.log(`  ✓  ${name}  ${kb(before)} → ${kb(after)}` +
        (finalName !== name ? `  （改名 ${finalName}，${rows.length} 处引用已更新）` : ''));
      bytesBefore += before; bytesAfter += after;
      done++;
    } catch (err) {
      await fsp.rm(path.join(UPLOAD_DIR, tmpName), { force: true });
      console.log(`  ✗  ${name}  —— ${err.message}`);
      failed++;
    }
  }

  // 顺带看一眼有没有没人引用的孤儿文件，只报告不删
  const all = (await fsp.readdir(UPLOAD_DIR)).filter((f) => !f.startsWith('.') && f !== '.incoming');
  const orphans = all.filter((f) => !valid.has(f));

  console.log(`\n  共 ${byName.size} 张被引用：` +
    (APPLY ? `已压 ${done} 张` : `待压 ${pending} 张`) +
    `，跳过 ${skipped}，文件缺失 ${missing}，失败 ${failed}`);
  if (APPLY && done) {
    console.log(`  体积 ${(bytesBefore / 1048576).toFixed(2)}MB → ${(bytesAfter / 1048576).toFixed(2)}MB` +
      `（省 ${(100 - (bytesAfter / bytesBefore) * 100).toFixed(0)}%）`);
  }
  if (orphans.length) console.log(`  ⚠ uploads/ 里还有 ${orphans.length} 个没人引用的文件（没动）：${orphans.join(', ')}`);
  if (!APPLY) console.log(`\n  预演结束。真改加 --apply： npm run recompress -- --apply`);
  console.log();
})().catch((e) => { console.error('出错了:', e); process.exit(1); });
