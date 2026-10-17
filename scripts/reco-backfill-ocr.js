#!/usr/bin/env node
// 给**历史阵容图**补跑 OCR 这一路（本地 OCR 认自带战法）。
//
//   node --env-file=.env scripts/reco-backfill-ocr.js              # 全量补
//   node --env-file=.env scripts/reco-backfill-ocr.js --dry        # 只看要补哪些、不写库
//   node --env-file=.env scripts/reco-backfill-ocr.js --limit 10   # 先拿 10 张试水
//
// ── 为什么这不是 worker 的启动任务 ──
//
// `recognize-worker` 的 runJob 会重新取图、重跑 NCC（2.5 秒/张）。要是照
// `filenamesMissingGuesses()` 的样子把"还没跑过 OCR 的"也塞进 sweep，进程每重启一次
// 就会把几百张历史图全部重推 —— 白跑一遍 NCC。所以补跑做成显式的一次性脚本。
//
// ── 它做的事 ──
//
// 1. 找出 `hero_guesses.ocr IS NULL` 的图（= 加这一路之前识别过的那些）；
// 2. 从 R2 取图 → 跑 `recognize-ocr.identify()`；
// 3. 用**库里存着的** NCC 快照 + 新算出来的 OCR 重新走一遍 `merge()`，
//    更新 `ocr` / `auto_key` / `confidence`。
//
// ★ 人工核对过的格子不会被覆盖 —— `db.saveGuesses` 里的 `CASE ... decided_at IS NULL`
//   兜着（那张表里最值钱的就是玩家的结论）。
//
// 幂等：已经补过的（ocr 有值）不会再被挑出来，跑多少遍都一样。

const fs = require('fs');
const path = require('path');
const db = require('../db');
const recognize = require('../recognize');
const ocrPath = require('../recognize-ocr');
const { imgUrl } = require('../upload');

const DRY = process.argv.includes('--dry');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i >= 0 ? Number(process.argv[i + 1]) || 0 : 0;
})();

const INDEX = path.join(__dirname, '..', 'herodata', 'index.json');
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

async function fetchImage(filename) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(imgUrl(filename), { signal: ctl.signal });
    if (!r.ok) throw new Error(`取图失败 ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// 库里存的是"每格的候选数组"，把它还原成 merge 要的 [{slot, candidates}]。
//
// ★ 整列一个值都没有 → 返回 **null 而不是空数组** —— 那是"这一路没跑过"的意思，
//   传给 merge 之后会原样写回 NULL。返回 `[]` 的话会变成 `'[]'`，把
//   "没跑过" 和 "跑了但没候选" 这两种含义永久地混在一起（见 db.saveGuesses 的注释）。
const perSlot = (rows, col) => {
  const have = rows.filter((r) => r[col] != null);
  if (!have.length) return null;
  return have
    .map((r) => { try { return { slot: r.slot, candidates: JSON.parse(r[col]) }; } catch { return null; } })
    .filter(Boolean);
};

(async () => {
  if (!ocrPath.available()) {
    console.error('✗ OCR 这一路没启用：检查 OCR_URL 和 herodata/index.json 里的 skill');
    process.exit(1);
  }
  if (!fs.existsSync(INDEX)) {
    console.error('✗ herodata/index.json 不在 —— 先把武将库放到线上目录');
    process.exit(1);
  }
  // 先播种一次：脚本可能跑在一个刚更新过 herodata 的目录上，
  // 而 heroes.skill 是这一路的词典来源（seedHeroes 幂等，跑几次都行）。
  db.seedHeroes(JSON.parse(fs.readFileSync(INDEX, 'utf8')).heroes);

  const todo = db.filenamesMissingOcr();
  const list = LIMIT ? todo.slice(0, LIMIT) : todo;
  console.log(`要补 ${list.length} 张（库里还差 ${todo.length} 张）${DRY ? ' —— 演练，不写库' : ''}`);
  if (!list.length) return;

  let okImgs = 0, ocrHits = 0, failed = 0, i = 0;
  for (const row of list) {
    i++;
    const tag = `[${i}/${list.length}] ${row.filename}`;
    let buf;
    try {
      buf = await fetchImage(row.filename);
    } catch (e) {
      failed++; console.error(`${tag} 取图失败：${e.message}`); continue;
    }

    let ocr = null;
    try {
      ocr = await ocrPath.identify(buf);
    } catch (e) {
      // 单张失败就跳过 —— 下一张还有机会。（服务整个挂了的话下面每张都会走到这里，
      // 打几行日志就能看出来，不用特别处理。）
      failed++; console.error(`${tag} OCR 失败：${e.message}`); continue;
    }

    const got = ocr.filter((s) => s.candidates.length).length;
    ocrHits += got;
    okImgs++;

    if (DRY) { console.log(`${tag} 认出 ${got}/9 格（演练，没写库）`); continue; }

    const rows = db.getGuesses(row.filename);
    const merged = recognize.merge(perSlot(rows, 'candidates'), ocr);
    db.saveGuesses(row.entry_id, row.filename, merged);
    console.log(`${tag} 认出 ${got}/9 格，已写库（高置信 ${merged.filter((m) => m.confidence === 'high').length}/9）`);
  }

  console.log(`\n完成：${okImgs} 张补过、${failed} 张失败；OCR 一共认出 ${ocrHits} 格`);
  if (failed) console.log('有失败的 —— 先看本地 OCR 服务是不是在跑（systemctl status ocr）');
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
