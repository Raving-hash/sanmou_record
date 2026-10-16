// 阵容识别的**第二路**：把整张「阵容配置」截图发给视觉模型，让它认这 9 个武将。
//
// 为什么要有第二路（2026-10-16 实测出来的，别凭感觉删）：
//   · 本地 NCC（recognize.js）头名 65%、前 3 含对 73%，不够全自动。
//   · 视觉模型头名 68% —— **单看也没好到哪去**。
//   · 但两路**头名一致的时候，63 格实测 28/28 全对**；不一致的 56% 里
//     VLM 对 19、NCC 对 13。也就是说两个方法**错在不同的格子上**，
//     一致 = 免费的置信度信号，不一致 = 老老实实标「待核对」。
//   所以这一路的产物不是"更准的答案"，是"一个独立的第二意见"。
//
// ── 用起来才知道的几件事 ──
//
//  1. **必须是整张图，不能只裁头像**。单张头像问「他是谁」，模型答错（把乐进答成庞德），
//     而且 6000 token 全烧在思考上、答案被截断。整页图有战法名、兵种角标、
//     上面「武将仓库」的已上阵标记当旁证，才认得出乐进这种冷门武将。
//     ⚠️ 代价是整页图里有玩家的昵称和 UID —— 用户 2026-10-16 明确点头同意发出去。
//
//  2. **开放的「他是谁」问不出东西，必须给名单当选择题**。实测开放式提问思考 12000 字
//     还在纠结；把 102 个显示名列出来之后 ~6000 token 就收敛，而且对得多。
//
//  3. **temperature: 0 也不保证确定性**。同一张图同一个 prompt 两次跑出不同答案
//     （董卓 / 荀攸）。所以**不能靠重跑取一致**，置信度只能靠"跟 NCC 一不一致"。
//
//  4. 它是**推理模型**，`reasoning_content` 也占 max_tokens。给少了会出现
//     "finish_reason=length 而 content 是空" —— 看着像答不出来，其实是没轮到开口。
//     max_tokens 因此给得很宽（40000）。

const db = require('./db');

const DIR = __dirname;                                   // 只为注释里指路，不读文件
const KEY = process.env.DS_API_KEY || '';
const BASE = String(process.env.DS_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
const MODEL = process.env.DS_MODEL || 'deepseek-flash';
const TIMEOUT_MS = Number(process.env.DS_TIMEOUT_MS || 180000);   // 实测 17~74 秒，留足余量
const MAX_TOKENS = Number(process.env.DS_MAX_TOKENS || 40000);
const TOP_N = 3;

// 没有 key 就整体不启用。**这是一条降级路径，不是错误** ——
// 站点照样跑，只是退回"只有 NCC 候选"的老样子（置信度一律 low）。
// 沙箱测试故意不给这个 key（见 .devlocal/test/reset.sh 的注释），
// 于是断言永远不会真的发一次请求出去。线上要手工在 .env 里补。
const enabled = () => !!KEY;

// 显示名（variant + name）→ 武将。库里的显示名是唯一的（同名两版靠 variant 区分），
// 所以这张表可以安全地反查。
let nameMap = null;
function heroNames() {
  if (!nameMap) {
    nameMap = new Map();
    for (const h of db.getHeroes()) nameMap.set((h.variant || '') + h.name, h);
  }
  return nameMap;
}
// 武将库是启动时播种的，播种之后要用新库得让这里重新建表
const resetCache = () => { nameMap = null; };

function buildPrompt() {
  const names = [...heroNames().keys()];
  return `这是游戏《三国谋定天下》的「阵容配置」页截图。
图中「我的比赛阵容」区有 3 支部队（部队一、部队二、部队三），每支部队从左到右 3 个武将，共 9 个。

请认出这 9 个武将。名字**必须**从下面这份名单里选，不要自创：

${names.join('、')}

每一格给 ${TOP_N} 个最可能的候选，**按可能性从高到低**排。认不出的格子给空数组。
只输出 JSON，不要解释、不要 markdown 代码块，形如：
{"1":["名字","名字","名字"],"2":[...],...,"9":[...]}
编号 1/2/3 = 部队一左/中/右，4/5/6 = 部队二，7/8/9 = 部队三。`;
}

// 从返回里把 JSON 抠出来。模型有时会裹一层 ```json，有时前面带一句客套话。
function extractJson(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const at = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (at < 0 || end <= at) return null;
  try { return JSON.parse(cleaned.slice(at, end + 1)); } catch { return null; }
}

// 认一张图。返回 [{ slot, candidates: [{ key, name, faction, arm, variant }] }]，
// 跟 recognize.recognize() 同构（少了 score，那边才有分数）。
//
// 抛错的场合只有"拿不到答案"（网络、超时、非 2xx、返回的不是 JSON）。
// 调用方（recognize-worker）**必须 catch 住并降级**，不能让一路挂掉拖垮整张图。
async function identify(buf) {
  if (!enabled()) throw new Error('未配置 DS_API_KEY，视觉识别未启用');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let body;
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: buildPrompt() },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${buf.toString('base64')}` } },
          ],
        }],
      }),
    });
    if (!r.ok) throw new Error(`视觉模型返回 ${r.status}：${(await r.text()).slice(0, 200)}`);
    body = await r.json();
  } finally {
    clearTimeout(timer);
  }

  const choice = body?.choices?.[0];
  const msg = choice?.message;
  const got = extractJson(msg?.content);
  if (!got) {
    // finish_reason=length 是最常见的一种：思考没写完就把预算烧光了。
    // 把这个原因写进错误里，省得下次又去猜"为什么答不出来"。
    throw new Error(`视觉模型没给出可解析的答案（finish=${choice?.finish_reason || '?'}，`
      + `思考 ${(msg?.reasoning_content || '').length} 字）`);
  }

  const map = heroNames();
  let unknown = 0;
  const out = [];
  for (let slot = 1; slot <= 9; slot++) {
    const raw = got[slot];
    const list = Array.isArray(raw) ? raw : [];
    const candidates = [];
    for (const name of list) {
      const h = map.get(String(name || '').trim());
      if (!h) { unknown++; continue; }
      if (candidates.some((c) => c.key === h.key)) continue;   // 同一格不重复推同一个武将
      candidates.push({ key: h.key, name: h.name, faction: h.faction, arm: h.arm, variant: h.variant });
    }
    out.push({ slot, candidates });
  }
  if (unknown) console.log(`[识别] 视觉模型给了 ${unknown} 个名单外的名字，已丢弃`);
  return out;
}

module.exports = { enabled, identify, resetCache, _prompt: buildPrompt, _extractJson: extractJson };
