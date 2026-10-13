#!/usr/bin/env node
// 备份数据库 + 所有图片到 backup/，并清理过旧的备份。
//
//   npm run backup              # 保留最近 30 份
//   KEEP=90 npm run backup      # 保留最近 90 份
//
// 数据库用 SQLite 的 VACUUM INTO 做一致性快照，不用停服务。

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../db');

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

// 2. 图片打包
const uploadsDir = path.join(ROOT, 'uploads');
const files = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
if (files.length) {
  execFileSync('tar', ['czf', upOut, '-C', ROOT, 'uploads']);
  console.log(`✓ 图片 ${files.length} 张 → ${path.relative(ROOT, upOut)} (${(fs.statSync(upOut).size / 1024).toFixed(0)} KB)`);
} else {
  console.log('· uploads/ 是空的，跳过图片打包');
}

// 3. 清理旧备份（按时间戳排序，db 和 tar 一起数）
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
