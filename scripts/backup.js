#!/usr/bin/env node
// 备份数据库 + 所有图片到 backup/，并清理过旧的备份。
//
//   npm run backup              # 保留最近 30 份
//   KEEP=90 npm run backup      # 保留最近 90 份
//
// 数据库用 SQLite 的 VACUUM INTO 做一致性快照，不用停服务。
//
// ★ 图片自 2026-10-15 起存在 Cloudflare R2 上，本地 uploads/ **不再更新**。
//   所以这里的做法是：从 R2 把对象拉到一个临时目录 → 打成 tar.gz → 删临时目录。
//   不改成这样的话，图片从此**不在任何备份里** —— 是静默的数据丢失，
//   而且不会有人发现，直到真的需要恢复的那一天。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ★ 自己补读 .env。package.json 里的 `backup` 脚本是 `node scripts/backup.js`，
//   **没有 --env-file** —— 而这一步需要 R2 的凭证。不能去改那个脚本：改了
//   package.json 就会被 .devlocal/release.sh:92 拦下（线上 node_modules 不跟 git 走），
//   等于每次发布都被拦住。所以在这里补。
//   只填**还没设过**的键 —— 保证命令行上的值优先，`KEEP=90 npm run backup` 照旧有效
//   （release.sh 自己就是 `npm run --silent backup` 这么调的）。
(function loadEnv() {
  if (typeof process.loadEnvFile !== 'function') return;   // Node < 20.12，那就靠调用方给
  const before = { ...process.env };
  try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch { return; }
  for (const [k, v] of Object.entries(before)) process.env[k] = v;
})();

const db = require('../db');
const { pullAll } = require('./r2-pull');

const ROOT = path.join(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, 'backup');
const KEEP = Number(process.env.KEEP || 30);

fs.mkdirSync(BACKUP_DIR, { recursive: true });

// 上海时区的 YYYYMMDD-HHMMSS，和容器里别的东西保持一致
const stamp = new Date()
  .toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
  .replace(/[-: ]/g, '')
  .replace(/^(\d{8})(\d{6})$/, '$1-$2');

const dbOut = path.join(BACKUP_DIR, `app-${stamp}.db`);
const upOut = path.join(BACKUP_DIR, `uploads-${stamp}.tar.gz`);

// 1. 数据库快照
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec(`VACUUM INTO '${dbOut.replace(/'/g, "''")}'`);
console.log(`✓ 数据库 → ${path.relative(ROOT, dbOut)} (${(fs.statSync(dbOut).size / 1024).toFixed(0)} KB)`);

// 2. 图片打包：从 R2 拉回来再打（本地 uploads/ 已不再更新，见文件头）
//    ★ 这一步失败**只警告 + 非零退出**，绝不能让上面那个库备份白做 ——
//      所以顺序是库在前、图在后，而且这里不抛。
async function backupImages() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yanwu-backup-'));
  try {
    const r = await pullAll(tmp);
    if (r.done === 0) {
      console.log('· R2 上没有对象，跳过图片打包');
      return false;
    }
    execFileSync('tar', ['czf', upOut, '-C', tmp, '.']);
    console.log(`✓ 图片 ${r.done} 个 → ${path.relative(ROOT, upOut)} (${(fs.statSync(upOut).size / 1024).toFixed(0)} KB)`);
    if (r.failed) {
      console.error(`⚠ 有 ${r.failed} 个对象没拉下来 —— **这份备份的图片不完整**，别当成成功。`);
      return true;
    }
    return false;
  } catch (e) {
    console.error(`⚠ 图片备份失败（库那份是好的）：${e.message}`);
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// 3. 清理旧备份（按时间戳排序，db 和 tar 一起数）
function prune() {
  const olds = fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^(app|uploads)-.*\.(db|tar\.gz)$/.test(f))
    .sort();
  const stamps = [...new Set(olds.map((f) => f.replace(/^(app|uploads)-/, '').replace(/\.(db|tar\.gz)$/, '')))];
  const drop = new Set(stamps.slice(0, Math.max(0, stamps.length - KEEP)));

  let removed = 0;
  for (const f of olds) {
    if (drop.has(f.replace(/^(app|uploads)-/, '').replace(/\.(db|tar\.gz)$/, ''))) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
      removed++;
    }
  }
  console.log(`· 共 ${stamps.length} 份备份，保留最近 ${KEEP} 份${removed ? `，清掉 ${removed} 个旧文件` : ''}`);
}

backupImages().then((imgFailed) => {
  prune();
  // 非零退出：调用方（.devlocal/release.sh 的 `npm run backup || die`）据此**拒绝发布**。
  // 这是故意的 —— 图片没备全就发版，等于把"恢复得回来"这件事赌掉了。
  if (imgFailed) process.exitCode = 1;
});
