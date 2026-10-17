#!/usr/bin/env node
// 按**当前**的合并规则重算历史行的 `auto_key` / `confidence`（不联网、不跑识别）。
//
//   node --env-file=.env scripts/reco-remerge.js --dry   # 只看会改哪些，不写库
//   node --env-file=.env scripts/reco-remerge.js         # 真写
//
// ── 为什么需要它 ──
//
// 2026-10-17 用户改了口径：「按照 ocr 的结果直接确定玩家的阵容」「去除视觉模型，
// OCR 认不出就 NCC」。`recognize.merge()` 随之变成"**OCR 优先，NCC 兜底**"。
// 新上传的图自然走新规则，但**库里已经算好的行还是旧规则的结果**。
// 这张表存着 `candidates` / `ocr` 两列快照，所以重算**不需要**再取图、再跑识别 ——
// 纯本地、零成本、幂等。
//
// ★ 只改**没人核对过**的行：`db.saveGuesses` 里的 `CASE ... decided_at IS NULL` 兜着，
//   玩家手工确认过的结论一个字节都不会动。这条和补跑脚本是同一条护栏。
//
// ★ 不碰 `ocr IS NULL` 的行？**碰，但结果不变**：那些行 merge 会走 NCC 兜底，
//   和旧规则里"没有 OCR 时用 NCC"本来就是一回事。所以不做筛选，全量重算最省事。

const db = require('../db');
const recognize = require('../recognize');

const DRY = process.argv.includes('--dry');

// 库里存的是"每格的候选数组"，还原成 merge 要的 [{slot, candidates}]。
// 整列一个值都没有 → **null 而不是空数组**（"这一路没跑过"，见 db.saveGuesses 的注释）。
const perSlot = (rows, col) => {
  const have = rows.filter((r) => r[col] != null);
  if (!have.length) return null;
  return have
    .map((r) => { try { return { slot: r.slot, candidates: JSON.parse(r[col]) }; } catch { return null; } })
    .filter(Boolean);
};

const files = db.prepare('SELECT DISTINCT filename, entry_id FROM hero_guesses ORDER BY filename').all();
console.log(`库里 ${files.length} 张阵容图${DRY ? '（演练，不写库）' : ''}`);

let changedFiles = 0, changedSlots = 0, undecided = 0;
for (const f of files) {
  const rows = db.getGuesses(f.filename);
  const merged = recognize.merge(perSlot(rows, 'candidates'), perSlot(rows, 'ocr'));
  const before = new Map(rows.map((r) => [r.slot, r]));

  let touched = 0;
  for (const m of merged) {
    const old = before.get(m.slot);
    if (!old || old.decided_at) continue;          // 人核对过的：连比较都不用比较
    undecided++;
    if ((old.auto_key || null) !== (m.auto_key || null)
        || (old.confidence || null) !== (m.confidence || null)) {
      touched++;
      if (DRY) console.log(`  ${f.filename} 第 ${m.slot} 格：${old.auto_key} → ${m.auto_key}`
        + `（${old.confidence} → ${m.confidence}）`);
    }
  }
  if (touched) {
    changedFiles++;
    changedSlots += touched;
    if (!DRY) db.saveGuesses(f.entry_id, f.filename, merged);
  }
}

console.log(`\n完成：${changedFiles} 张图有变化、共 ${changedSlots} 格`
  + `（核对过的行 ${files.length ? '未计入' : ''}；待核对格总数 ${undecided}）`);
if (DRY && changedSlots) console.log('去掉 --dry 才会真写。');
