// 阵容识别的后台队列。
//
// 为什么要有这一层：识别一张图约 2.5 秒（外加从 R2 把图下回来的时间），
// 而**全站是同步请求-响应**的 Express —— 在 POST /lineup 里直接跑，玩家会卡在那儿，
// 并发几个人就能把进程占满。所以上传只负责"把文件名推进队列"，算的活儿在这儿慢慢做。
//
// 全站没有队列基础设施（最近的先例是 limiter.js 的 setInterval(...).unref()），
// 这里照那个路子来：**一个进程内的数组 + 一个定时器 + 严格串行**。
// 串行是故意的 —— 识别是 CPU 密集的，并行跑只会互相拖慢，还抢 Express 的线程。
//
// 进程重启后内存队列会丢，所以启动时扫一遍库：**没有 hero_guesses 行的阵容图**
// 全部补进队列（见 db.filenamesMissingGuesses）。

const fs = require('fs');
const path = require('path');
const db = require('./db');
const { imgUrl } = require('./upload');
const recognize = require('./recognize');

const INDEX = path.join(__dirname, 'herodata', 'index.json');
const TICK_MS = 3000;
const MAX_FAIL = 3;           // 同一张图连续失败这么多次就放弃（内存里记着，重启会再试）

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
  const url = imgUrl(filename);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`取图失败 ${r.status} ${filename}`);
  return Buffer.from(await r.arrayBuffer());
}

async function process(job) {
  const buf = await fetchImage(job.filename);
  const list = await recognize.recognize(buf);
  db.saveGuesses(job.entryId, job.filename, list);
  const top = list.map((s) => s.candidates[0]?.name || '?').join(' ');
  console.log(`[识别] ${job.filename} 完成：${top}`);
}

async function tick() {
  if (busy || !queue.length) return;
  const job = queue.shift();
  busy = true;
  try {
    await process(job);
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
  if (rows.length) console.log(`[识别] 启动补跑 ${rows.length} 张`);
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
    console.log(`[识别] 武将库 ${idx.heroes.length} 个已就位`);
  } catch (e) {
    console.error('[识别] 武将库播种失败，识别不启用：', e.message);
    return;
  }
  // 库还没热的时候第一张要等一两秒（102 张卡面要解码 + 算模板），
  // 提前热一下，免得第一个玩家的图白等。
  recognize.load().catch((e) => console.error('[识别] 预热失败：', e.message));
  sweep();
  timer = setInterval(tick, TICK_MS);
  // unref：这个定时器不该拖着进程不让退出（照 limiter.js 的写法）
  if (timer.unref) timer.unref();
}

module.exports = { start, enqueue, enabled, _queue: queue };
