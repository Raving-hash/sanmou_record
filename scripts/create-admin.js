#!/usr/bin/env node
// 创建（或提升）一个管理员账号。
//
//   npm run admin -- <userId> <昵称> [密码]
//
// 不给密码就随机生成一个并打印出来。userId 已存在时会把它提为管理员，
// 此时若同时给了密码，会顺带把密码改掉。

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');

const [userIdRaw, nickname, password] = process.argv.slice(2);

if (!userIdRaw || !nickname) {
  console.error('用法：npm run admin -- <userId> <昵称> [密码]');
  console.error('例如：npm run admin -- laoda 老大哥');
  process.exit(1);
}

const userId = userIdRaw.trim().toLowerCase();
if (!/^[a-z0-9_]{3,20}$/.test(userId)) {
  console.error(`✗ ID「${userId}」不合规：需要 3–20 位小写字母、数字或下划线`);
  process.exit(1);
}
if ([...nickname].length < 1 || [...nickname].length > 12) {
  console.error('✗ 昵称需要 1–12 个字');
  process.exit(1);
}

const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';
const genPassword = () =>
  Array.from(crypto.randomBytes(10), (b) => ALPHA[b % ALPHA.length]).join('');

const plain = password || genPassword();
if (plain.length < 6) {
  console.error('✗ 密码至少 6 位');
  process.exit(1);
}

const existing = db.getUserByUid(userId);

if (existing) {
  db.prepare('UPDATE users SET is_admin=1, nickname=?, is_disabled=0 WHERE id=?')
    .run(nickname, existing.id);
  if (password) {
    db.prepare('UPDATE users SET password_hash=? WHERE id=?')
      .run(bcrypt.hashSync(password, 10), existing.id);
  }
  console.log(`✓ 已把「${nickname}（${userId}）」设为管理员${password ? '，并更新了密码' : '（密码未改动）'}`);
} else {
  db.createUser({ userId, nickname, passwordHash: bcrypt.hashSync(plain, 10), isAdmin: 1 });
  console.log(`✓ 管理员已创建：${nickname}（${userId}）`);
  if (!password) console.log(`  临时密码：${plain}`);
  console.log('  请登录后用「改密码」换成自己的密码。');
}
