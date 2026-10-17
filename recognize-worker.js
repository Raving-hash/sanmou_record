// 阵容识别的后台队列。
//
// 为什么要有这一层：识别一张图本地要 ~2.5 秒（全站是同步请求-响应的 Express）——
// 在 POST /lineup 里直接跑，玩家会卡在那儿，并发几个人就能把进程占满。
// 所以上传只负责"把文件名推进队列"，算的活儿在这儿慢慢做。
//
// 全站没有队列基础设施（最近的先例是 limiter.js 的 setInterval(...).unref()），
// 这里照那个路子来：**一个进程内的数组 + 一个定时器 + 严格串行**。
// 串行是故意的 —— NCC 是 CPU 密集的，并行跑只会互相拖慢，还抢 Express 的线程。
//
// **两路**识别（本地 OCR 认自带战法 + 本地 NCC）都在这一条队列里跑完再写库，
// 因为要合起来才能定置信度（见 recognize.merge）。
// ★ 2026-10-17 用户口径「去除视觉模型，OCR 认不出就 NCC」—— 远端视觉模型那一整路
//   已删除（连同 recognize-vlm.js 和 DS_API_KEY）。合并规则变成 `ocr || ncc`。
//
// 进程重启后内存队列会丢，所以启动时扫一遍库：没有 hero_guesses 行的阵容图全流程补跑
// （见 db.filenamesMissingGuesses）。
//
// ⚠️ **历史图补跑 OCR 没有对应的 sweep 批次。** 要补就显式跑
//    `node --env-file=.env scripts/reco-backfill-ocr.js`（它只补 ocr 那一列，
//    拿库里存着的 NCC 快照一起重新 merge，不会重新取图跑 NCC）。

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { imgUrl } = require('./upload');
const recognize = require('./recognize');
const ocrPath = require('./recognize-ocr');
const locate = require('./locate');

const INDEX = path.join(__dirname, 'herodata', 'index.json');
const TICK_MS = 3000;
const MAX_FAIL = 3;           // 同一张图连续失败这么多次就放弃（内存里记着，重启会再试）
// 从 R2 取图的超时。从前这里**完全没有超时**，代理一抖就会把整条串行队列吊死 ——
// 后面排着的图全都不动了，而且日志里一个字都没有。r2.js 一直是有超时的，这里漏了。
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 30000);

const queue = [];             // [{ filename, entryId }]
const queued = new Set();     // 去重，避免同一张图被反复推
const fails = new Map();      // filename -> 连续失败次数
let busy = false;
let timer = null;

const enabled = () => fs.existsSync(INDEX);

function enqueue(filename, entryId) {
  if (!enabled() || !filename || queued.has(filename)) return;
  queued.add(filename);
  queue.push({ filename, entryId });
}

// 把图从 R2 下回来。图片是浏览器直传上去的，服务端从来没经手过字节。
async function fetchImage(filename) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(imgUrl(filename), { signal: ctl.signal });
    if (!r.ok) throw new Error(`取图失败 ${r.status} ${filename}`);
    return Buffer.from(await r.arrayBuffer());
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`取图超时（${FETCH_TIMEOUT_MS}ms）${filename}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ⚠️ 这个函数**不能叫 `process`**：函数声明会提升到模块作用域，把 Node 的全局
//    `process` 整个挡住 —— 于是本文件顶层的 `process.env.XXX` 全都读到 undefined，
//    报错还是 "Cannot read properties of undefined"，看着像环境没配好。
//    （上一版它就叫 process，只是当时模块顶层没读过 process.env，所以没炸。）
async function runJob(job) {
  const buf = await fetchImage(job.filename);

  // 先定位九个格子（竖屏/横屏是两套版面，见 locate.js）。**失败就返回 null**，
  // recognize 会退回原来那套写死的坐标 —— 定位器出任何问题都不该让识别整体挂掉。
  const grid = await locate.locate(buf);
  const ncc = await recognize.recognize(buf, 3, grid && grid.boxes);

  // 第一路：本地 OCR 认自带战法名（见 recognize-ocr.js）—— **定阵容的那一路**。
  // 挂了就置 null，绝不让它拖垮整张图：NCC 会兜底，只是覆盖率掉一截。
  // 它和 NCC 不一样：**一张图 9 格同生共死**（服务挂掉 = 整张图这条路全空），
  // 所以这里失败时打出来的 ocrGot 会是 0/9 而不是"某几格"。
  let ocr = null;
  if (ocrPath.available()) {
    try {
      ocr = await ocrPath.identify(buf);
    } catch (e) {
      console.error(`[识别] 本地 OCR 失败，这张降级为只用 NCC：${e.message}`);
    }
  }

  // 第二路（2026-10-17 起也是最后一路）：本地 NCC。OCR 认不出的格子由它兜底。
  const merged = recognize.merge(ncc, ocr);
  db.saveGuesses(job.entryId, job.filename, merged);

  const filled = merged.filter((m) => m.auto_key).length;
  const high = merged.filter((m) => m.confidence === 'high').length;
  // NCC 有几个格子拿到了候选 —— **这一行是判断定位对不对的主要实据**：
  // 横屏以前恒为 0/9（坐标是按竖屏写死的），现在应该接近 9/9。
  const nccGot = ncc.filter((s) => (s.candidates || []).length).length;
  const ocrGot = (ocr || []).filter((s) => (s.candidates || []).length).length;
  // 从前这里打的是九个 `?`（没有候选时），看着像报错、其实是正常的 ——
  // 玩家传的要不是「阵容配置」页，九格本来就一个都认不出来。改成人话。
  const tail = ` · NCC ${nccGot}/9 · OCR ${ocr === null ? '未启用/失败' : `${ocrGot}/9`}`
    + ` · 版面 ${grid ? grid.layoutName : '未定位→回退竖屏坐标'}`;
  console.log(filled
    ? `[识别] ${job.filename} 填了 ${filled}/9 格（两路一致 ${high}）${tail}`
    : `[识别] ${job.filename} 一个都没认出来（多半传的不是「阵容配置」页）${tail}`);
}

async function tick() {
  if (busy || !queue.length) return;
  const job = queue.shift();
  busy = true;
  try {
    await runJob(job);
    fails.delete(job.filename);
    queued.delete(job.filename);
  } catch (e) {
    const n = (fails.get(job.filename) || 0) + 1;
    fails.set(job.filename, n);
    console.error(`[识别] ${job.filename} 第 ${n} 次失败：${e.message}`);
    if (n < MAX_FAIL) {
      // 放回队尾再试一次。不改 queued —— 它还在队列里，不该被重复推入。
      queue.push(job);
    } else {
      console.error(`[识别] ${job.filename} 放弃（连续失败 ${n} 次）`);
      queued.delete(job.filename);
    }
  } finally {
    busy = false;
  }
}

// 启动时补跑：进程重启会把内存队列清空，而库里可能积着没识别的图。
function sweep() {
  const rows = db.filenamesMissingGuesses();
  rows.forEach((r) => enqueue(r.filename, r.entry_id));
  if (rows.length) console.log(`[识别] 启动补跑 ${rows.length} 张（从没识别过的）`);
  // 2026-10-17 删掉了"补跑视觉模型"那一批（模型已移除，见 db.filenamesMissingVlm 的删除）。
  // 补跑 OCR 不放进 sweep：它要显式跑 scripts/reco-backfill-ocr.js，理由见文件头。
}

function start() {
  if (!enabled()) {
    console.log('[识别] herodata/ 不在，识别功能未启用');
    return;
  }
  // 先把武将库播进库里。库文件改了（补武将、改兵种）重启即生效。
  try {
    const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
    db.seedHeroes(idx.heroes);
    // OCR 有一份"战法名 → 武将"的缓存，库刚变过（可能刚补上 skill），得重建
    ocrPath.resetCache();
    console.log(`[识别] 武将库 ${idx.heroes.length} 个已就位`);
  } catch (e) {
    console.error('[识别] 武将库播种失败，识别不启用：', e.message);
    return;
  }
  // 两路各自可能因为没配而关闭，启动时把"到底跑几路、为什么少"一次说清楚 ——
  // 否则线上只能靠"置信度怎么看都不 high"去反推，很费时间。
  console.log('[识别] 在跑：本地 NCC'
    + (ocrPath.available() ? ' + 本地 OCR 自带战法（优先）'
      : `（本地 OCR 那一路关闭：${!process.env.OCR_URL ? '没配 OCR_URL' : '武将库里没有 skill'}，OCR 认不出时才靠 NCC）`));
  // 库还没热的时候第一张要等一两秒（102 张卡面要解码 + 算模板），
  // 提前热一下，免得第一个玩家的图白等。
  recognize.load().catch((e) => console.error('[识别] 预热失败：', e.message));
  sweep();
  timer = setInterval(tick, TICK_MS);
  // unref：这个定时器不该拖着进程不让退出（照 limiter.js 的写法）
  if (timer.unref) timer.unref();
}

module.exports = { start, enqueue, enabled, _queue: queue };
