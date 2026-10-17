#!/usr/bin/env node
// 一个假的"接收端点"，只为一件事：让抓取那一头在**真接口不通的时候**也能验到底。
//
//   node scripts/rank-mock-receiver.js --port 8787 --token abc
//   node scripts/rank-shot.js --capture --post http://127.0.0.1:8787/api/scores --token abc
//
// 它照的是**真接口**的形状（2026-10-18 拿真接口问出来的那份）：
//   POST /api/scores
//   Authorization: Bearer <token>
//   Content-Type: application/json
//   [ {"game_name":"善丨路飞王","score":84}, {"game_name":"善丨大葱王","score":59} ]   ← 裸数组，一次全发
// 回执与请求等长同序：{"ok":true,"season":"mock","updated":N,"results":[…]}
// 令牌不对 401，不是数组/字段不对 400。
//
// 分数存在内存里，所以 `changed` / `previous` 是**真的**（同一份抓取连发两遍，
// 第二遍会全 `changed:false`）—— 用来验"幂等"和客户端的回执统计。
// 收到什么就打印什么，并逐条追加到 --log（默认 data/rank-import.jsonl）。
//
// **不写站点库、不认人** —— 它唯一的作用是回答"客户端到底发了什么"，别拿它当后端。
// 它**没有**真接口的模糊匹配/歧义弃权那一层：任何名字都回 ok + exact，所以拿它跑一轮会看到
// "全匹配"（`notOnSite=0`），那个数字不能当真，只用来验报文形状和回执统计。
const fs = require('fs');
const path = require('path');
const http = require('http');

const opt = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};

const PORT = Number(opt('--port', 8787));
const TOKEN = opt('--token', '');
const LOG = path.resolve(opt('--log', path.join(__dirname, '..', 'data', 'rank-import.jsonl')));
const BODY_LIMIT = 1 << 20;                 // 一包 300 条也就 20KB，1MB 足够宽松

const scores = new Map();                    // game_name -> score（只是内存，重启即清空）
let bodies = 0;
let entries = 0;

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  };

  if (req.method !== 'POST') return send(405, { ok: false, error: '只收 POST' });
  if (TOKEN && (req.headers.authorization || '') !== `Bearer ${TOKEN}`) {
    return send(401, { ok: false, error: 'token 不对' });
  }

  let body = '';
  req.on('data', (c) => {
    body += c;
    if (body.length > BODY_LIMIT) req.destroy();
  });
  req.on('end', () => {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      return send(400, { ok: false, error: '不是合法 JSON' });
    }
    // 真接口收裸数组；单个对象也照样收，方便手工 curl 试一条
    const list = Array.isArray(payload) ? payload : [payload];
    let updated = 0;
    const results = list.map((it) => {
      const name = it && it.game_name;
      const score = it && it.score;
      if (typeof name !== 'string' || !name) {
        return { game_name: '', status: 'invalid', error: 'game_name 不能为空' };
      }
      if (!Number.isInteger(score)) {
        return { game_name: name, status: 'invalid', error: 'score 必须是整数' };
      }
      const previous = scores.has(name) ? scores.get(name) : null;
      const changed = previous !== score;
      if (changed) {
        scores.set(name, score);
        updated++;
      }
      return { game_name: name, score, status: 'ok', user_id: 'mock-' + name, nickname: name, match: 'exact', previous, changed };
    });

    bodies++;
    entries += list.length;
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    for (const r of results) {
      if (r.status === 'ok') fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), game_name: r.game_name, score: r.score }) + '\n');
    }
    console.log(`  #${bodies} 收 ${list.length} 条，写入 ${updated} 条`);
    send(200, { ok: true, season: 'mock', updated, results });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`假接收端在 http://127.0.0.1:${PORT}/api/scores（日志：${LOG}）`);
  console.log('等 POST … Ctrl+C 退出');
});
