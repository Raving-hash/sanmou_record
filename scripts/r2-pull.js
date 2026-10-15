#!/usr/bin/env node
/* ==========================================================================
   把 R2 上的对象拉回本地。**两个用途共用一份实现，别抄第二份**：

     ① **备份**（scripts/backup.js 调它）：拉到一个临时目录再打成 tar.gz。
        图片搬到 R2 之后，`tar uploads/` 那一步就没有意义了 —— 不改成从 R2 拉，
        图片从此不在任何备份里，是**静默的数据丢失**。
     ② **回滚**：cutover 之后新传的图**只在 R2 上**（后端不再经手字节，本地
        uploads/ 停在迁移那一刻）。要把线上退回旧代码，必须先把这些对象拉回
        uploads/，否则"回滚回去发现最近的图全没了"。
        ★ 所以这个脚本必须在 **cutover 之前**就写好并验过，不能等出事再写。

   跑法：
     node --env-file=.env scripts/r2-pull.js --dest ./r2-pull        # 拉全量
     node --env-file=.env scripts/r2-pull.js --dest uploads          # 回滚时填回 uploads/
     node --env-file=.env scripts/r2-pull.js --dest /tmp/x --dry-run # 只报会和不会写

   ★ key 里的 `/` 是**真的路径分隔符**，所以落盘时会自动建子目录。现在本站的 key
     是平铺的（`<uuid>.jpg`），但别假设它永远是 —— 按目录结构写才对。
   ★ 流式写（`pipeline`），不整块进内存：整个桶可能几百 MB，没必要。
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const r2 = require('../r2');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DRY = process.argv.includes('--dry-run');

// 拉全量。导出给 backup.js 复用 —— 备份和回滚必须走同一套取数逻辑，
// 抄一份到别处迟早会改岔（这个仓库为这件事吃过苦头，见 README 里
// 「抄一份到脚本里迟早会和这里改岔」那句）。
async function pullAll(dest, { onProgress = null, dryRun = false } = {}) {
  const objects = await r2.listAll();
  const total = objects.length;
  const sum = objects.reduce((n, o) => n + o.size, 0);
  let done = 0, bytes = 0, failed = 0;
  const skipped = [];

  if (!dryRun) fs.mkdirSync(dest, { recursive: true });

  for (const o of objects) {
    // 以 `/` 结尾的是**文件夹占位对象**（零字节），在控制台里建目录时会产生。
    // 它没有内容可写 —— 按普通文件处理会去 open 一个 `.part`，父目录还不存在，
    // 直接 ENOENT，然后被算成"拉取失败"，备份那句"不完整"就是**误报**。
    // 正确做法是把它建成目录、不算失败。（本站的 key 全是平铺的文件名，
    // 这一条是冲着桶里可能出现的杂项去的。）
    if (o.key.endsWith('/')) {
      if (!dryRun) fs.mkdirSync(path.join(dest, o.key), { recursive: true });
      skipped.push(o.key);
      done++;
      if (onProgress) onProgress(done, total, o.key);
      continue;
    }

    const full = path.join(dest, o.key);
    try {
      if (dryRun) {
        done++; bytes += o.size;
      } else {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        // 先写 .part 再 rename：中途断了不会在目标目录里留下一个半截的文件
        // 被当成完整的（backup 那边是干净的临时目录，但回滚时目标就是 uploads/，
        // 那个目录里的东西是真的会被服务读的）。
        const tmp = full + '.part';
        await pipeline(await r2.getObject(o.key), fs.createWriteStream(tmp));
        fs.renameSync(tmp, full);
        done++; bytes += o.size;
      }
    } catch (e) {
      failed++;
      console.error(`  ✗ ${o.key}  ${e.message}`);
      try { fs.rmSync(full + '.part', { force: true }); } catch { /* 清不掉就算了 */ }
    }
    if (onProgress) onProgress(done, total, o.key);
  }

  return { total, done, failed, bytes, expectedBytes: sum, skipped };
}

async function main() {
  const dest = arg('--dest', path.join(__dirname, '..', 'r2-pull'));
  console.log(`\n从 ${r2.BUCKET} 拉到 ${dest}${DRY ? '（预演）' : ''}\n`);

  const r = await pullAll(dest, {
    dryRun: DRY,
    onProgress: (done, total, key) => {
      if (done % 20 === 0 || done === total) {
        process.stdout.write(`\r  ${done}/${total}  ${(done / total * 100).toFixed(0)}%   `);
      }
      if (done === total) process.stdout.write(`\n`);
      void key;
    },
  });

  console.log(`\n拉取 ${r.done} ／ 失败 ${r.failed}  ·  ${(r.bytes / 1024 / 1024).toFixed(2)} MB`);
  if (r.skipped.length) {
    console.log(`  · 桶里这些不是文件（文件夹占位对象），已建成目录：${r.skipped.join('、')}`);
  }
  if (r.failed) {
    console.error('⚠ 有对象没拉下来 —— 备份不完整，别当成成功。');
    process.exitCode = 1;
  }
}

if (require.main === module) main().catch((e) => { console.error('炸了：', e); process.exit(1); });

module.exports = { pullAll };
