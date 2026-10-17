// 阵容识别的**主路**：本地 OCR 认「自带战法名」，反查武将。
// （2026-10-17 用户口径「按照 ocr 的结果直接确定玩家的阵容」「去除视觉模型，
//   OCR 认不出就 NCC」—— 这一路给了答案就填它，NCC 只负责兜底。）
//
// ── 这一路凭什么准 ──
//
// 每个武将的**自带战法名唯一**，而且游戏里每张卡的**第一行**印的就是它。
// 102 个自带战法名零撞名，连同名变体都各不相同：
//     诸葛亮=草船借箭 / SP诸葛亮=星罗棋布；孙坚=武烈破虏 / 群雄孙坚=诛凶殄逆
// 所以它同时解决了两件事：
//   · 比"看脸"（NCC）**硬得多**；
//   · 顺手补上 NCC 的软肋 —— 同名变体（NCC 只看头像，分不出主名和变体）。
//
// 2026-10-16 在 142 个人工核对过的格子上实测（17 张真图）：
//     NCC 41/58 = 70.7%   **本路 111/120 = 92.5%**
// （同日还在线的远端视觉模型是 68.3%，2026-10-17 已按用户要求整路删除。）
// 见 recognize.js 的 merge：OCR 优先，OCR 认不出才用 NCC。
//
// ── ⚠️ 顺序不能颠倒：是**拿文字当定位器**，不是"先按坐标裁窗再认字" ──
//
// 我原先的做法是"用 locate.js 的头像框，逐格裁一条文字窗出来 OCR"。实测**只有 71.8%**，
// 而"整块阵容区 OCR 一遍、让文字自己聚成 3×3"是 **78.2%**。差别出在异形宽高比的图上：
// 2436×1125（2.17）、2560×1152（2.22）、1716×889（1.93）这些比例会落到 locate.js 的
// landscape 族但相对坐标会漂（locate.js 文件头早就预警过），于是裁窗整片错位。
// **OCR 并不天然免疫定位器的洞** —— 但把定位这件事交给文字本身，就绕开了。
//
// 下面这几条都是实测出来的岔路，别再走一遍：
//
//  1. **按"间隙"聚类 → 缺锚点就塌。** 一开始我用"y 相邻差 > 某阈值就断行"，
//     端到端只有 51.4%：一格里没认出字（比如「诛凶殄逆」里的"殄"是生僻字）就会让
//     整行/整列**错位**位移（实测 7d2bb031 的部队三整行被安上了部队二的武将）。
//     改成 `splitK()` —— **强制切出正好 3 行 3 列**（挑 k-1 个最大间隙当刀口）——
//     缺锚点就只是那一格空着，不会连累别人。78.2% vs 51.4% 全在这一个改动上。
//  2. **不能拿词典去撞三行。** 自带战法名**也可能被别人装备**：「算无遗策」是郭嘉的
//     自带，同时是可装备战法，会出现在别人卡的第 2/3 行。撞三行会造出大批假命中
//     （第一版 8 个判错里 5 个是它；现在仍是头号错因）。规则必须是
//     **取格内最靠上的那个锚点**。
//  3. **"格内最上面那块文字"不成立。** 试过让所有文字块（不限于锚点）参与定"第一行"，
//     它若不在词典里就弃权 —— 掉到 47.2%。因为左边「部队一」「部队交换」这类标签会
//     顶进格子里，一格没认出来就整格弃权，弃权太多了。
//  4. **别预放大。** 小图（433×309、1320×998）确实吃亏，但把裁块先放大到短边 1200/1600
//     再 OCR，准确率**反而略降**（78.2% → 77.5% → 76.8%）。DBNet 内部本来就会把短边
//     缩放到 960，再叠一层是白费。
//  5. **裁的是"阵容区"不是整图。** 整图 OCR 会把右侧的**武将仓库/战法仓库**也读进来，
//     那里成片是战法名 —— 全是假锚点。裁一块宽松的阵容区既排掉它们，又仍然容忍坐标漂。
//
// ── 用起来才知道的几件事 ──
//
//  · 一路 9 格同生共死：服务挂了整张图 9 格全空（返回 `[]` 候选），不是"某格没认出来"。
//    调用方照着"失败就降级"的契约 catch 住即可，别让一路拖垮整张图。
//  · 词典来自 `heroes.skill`。**一个 skill 都没有 = 这一路整体不启用**（见 available()），
//    线上没放带 skill 的 herodata/index.json 时行为与从前一字不差。这也是沙箱的隔离开关。

const sharp = require('sharp');
const db = require('./db');
const locate = require('./locate');

const URL = String(process.env.OCR_URL || '').trim();
const TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS || 60000);

// 一条文字被认为是「某个自带战法」的最低相似度：1 - 编辑距离/较长串长。
// 0.5 = 四字名容错两个字（「诛凶玲递」→「诛凶殄逆」正好 0.5）。
// 实测 0.5 / 0.75 两档：放宽到 0.5 覆盖率从 84.5% 涨到 92.5% 而精确率只掉 2 个点，故选它。
const MIN_SIM = 0.5;

// 阵容区（相对整图的比例）。**故意取得宽松** —— 它的作用只是"把武将仓库排除在外"，
// 精确到格子的活儿由文字块的坐标来干，所以漂几个百分点无所谓。
// 这两个数是在 uploads/ 里那 17 张真图上量的：竖屏一行只到 y≈0.78（再往下是下一支部队的
// 标题），横屏左边 0.62 之外就是武将仓库了。放宽一点是为了容忍异形比例，不是精确值。
const REGION = {
  portrait: { left: 0, top: 0.50, width: 0.88, height: 0.30 },
  landscape: { left: 0, top: 0.10, width: 0.62, height: 0.68 },
};

// 战法名 → 武将。惰性建、可失效（resetCache）。
let skillMap = null;
function dict() {
  if (!skillMap) {
    skillMap = new Map();
    for (const h of db.getHeroes()) {
      const s = String(h.skill || '').trim();
      if (s) skillMap.set(s, h);
    }
  }
  return skillMap;
}
// 武将库是启动时播种的；播种之后要用新库（或新补的 skill）得让这里重建。
const resetCache = () => { skillMap = null; };

const enabled = () => !!URL;
// 「能不能真的干活」：配了服务地址，**且**库里有带 skill 的武将。
// 两样缺一个就整体不启用 —— 照 recognize.js 的 available() 先例，是一路降级而不是错误。
const available = () => !!URL && dict().size > 0;

// ── 编辑距离 ──
// 名字都很短（2~4 字），朴素实现足够；不值得引依赖。
function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);

// 把一串数字**强制切成正好 k 段** —— 挑 k-1 个最大间隙当刀口。
//
// ★ 这个函数是这一路的命门。用它而不是"按阈值断行"，是为了**缺数据时不塌**：
//   9 格里有一格没认出字（生僻字、分辨率不够）时，阈值法会把相邻两行并成一行、
//   导致后面所有格子整体错位；强制切 k 段则只是让那一格空着。
//   51.4% → 78.2% 就是这么来的，别改回阈值法。
//   值的个数少于 k 时退化成"每个值自己一段"，调用方拿到的段数是值的个数 —— 够用了。
function splitK(values, k) {
  const s = [...values].sort((x, y) => x - y);
  if (s.length <= k) return s.map((v) => [v]);
  const gaps = [];
  for (let i = 1; i < s.length; i++) gaps.push({ i, g: s[i] - s[i - 1] });
  gaps.sort((x, y) => y.g - x.g);
  const cuts = gaps.slice(0, k - 1).map((x) => x.i).sort((x, y) => x - y);
  const out = [];
  let st = 0;
  for (const c of cuts) { out.push(s.slice(st, c)); st = c; }
  out.push(s.slice(st));
  return out;
}

// 每段的值 → 段与段之间的分界（取相邻两段的交界中点）。
// 用它把**任意**坐标归到 0..k-1 的行/列号，而不是只给"参与聚类的那些点"用。
function boundsOf(groups) {
  const b = [];
  for (let i = 0; i < groups.length - 1; i++) {
    b.push((groups[i][groups[i].length - 1] + groups[i + 1][0]) / 2);
  }
  return b;
}
const bucket = (v, bounds) => {
  let n = 0;
  for (const b of bounds) if (v > b) n++;
  return n;
};

// 认一张图。返回 [{slot, candidates:[{key,name,faction,arm,variant,score}]}]，与
// recognize.recognize() 同构。
//
// 抛错的场合只有"拿不到答案"（服务不可达、超时、非 2xx、返回的不是 JSON）。
// 调用方（recognize-worker）**必须 catch 住并降级** —— 抛出只表示"这一路这次没答案"。
async function identify(buf) {
  if (!enabled()) throw new Error('未配置 OCR_URL，本地 OCR 未启用');
  const map = dict();
  if (!map.size) throw new Error('武将库里没有任何 skill（自带战法），本地 OCR 无法反查');

  const meta = await sharp(buf).metadata();
  if (!meta.width || !meta.height) throw new Error('读不出图片尺寸');

  // 版面族只用来选裁哪一块。**不读 locate 的九个框** —— 见文件头第「顺序不能颠倒」一节。
  // locate 拿不到版面时退回按宽高比判（和 locate.pickLayout 同一条边界：宽 < 高即竖屏），
  // 别默认成横屏 —— 那样竖屏图会裁到腰部以下，一格都认不出来。
  const loc = await locate.locate(buf);
  const layoutName = loc ? loc.layoutName
    : (meta.width < meta.height ? 'portrait' : 'landscape');
  const region = REGION[layoutName] || REGION.landscape;

  const crop = {
    left: Math.round(region.left * meta.width),
    top: Math.round(region.top * meta.height),
    width: Math.round(region.width * meta.width),
    height: Math.round(region.height * meta.height),
  };
  crop.width = Math.min(crop.width, meta.width - crop.left);
  crop.height = Math.min(crop.height, meta.height - crop.top);
  if (crop.width < 32 || crop.height < 32) throw new Error('阵容区裁块太小，这张图不是阵容配置页');

  const png = await sharp(buf).extract(crop).png().toBuffer();

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let body;
  try {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: png,
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`本地 OCR 返回 ${r.status}：${(await r.text()).slice(0, 200)}`);
    body = await r.json();
  } finally {
    clearTimeout(timer);
  }

  const blocks = Array.isArray(body && body.blocks) ? body.blocks : [];

  // ① 每个文字块去撞词典，够像的才算「锚点」。
  const anchors = [];
  for (const b of blocks) {
    const text = String(b.text || '').trim();
    // 没有坐标就没法参与聚格 —— 一个坏块不该让整张图走 catch 降级。
    if (!text || !Array.isArray(b.box) || !b.box.length) continue;
    let best = null, bestScore = -1;
    for (const skill of map.keys()) {
      const s = sim(text, skill);
      if (s > bestScore) { bestScore = s; best = skill; }
    }
    if (bestScore < MIN_SIM) continue;
    const xs = b.box.map((p) => p[0]);
    const ys = b.box.map((p) => p[1]);
    anchors.push({
      hero: map.get(best),
      score: bestScore,
      cx: (Math.min(...xs) + Math.max(...xs)) / 2,
      cy: (Math.min(...ys) + Math.max(...ys)) / 2,
    });
  }

  // ② 锚点自己聚成 3×3。锚点太少（不足一行）就别硬凑，整张图弃权。
  const cells = new Map();                       // slot → 该格最靠上的锚点
  if (anchors.length >= 3) {
    const rowGroups = splitK(anchors.map((a) => a.cy), 3);
    const colGroups = splitK(anchors.map((a) => a.cx), 3);
    const rowBounds = boundsOf(rowGroups);
    const colBounds = boundsOf(colGroups);
    for (const a of anchors) {
      const slot = bucket(a.cy, rowBounds) * 3 + bucket(a.cx, colBounds) + 1;
      const cur = cells.get(slot);
      if (!cur || a.cy < cur.cy) cells.set(slot, a);   // ★ 最靠上那个 = 自带战法那一行
    }
  }

  const out = [];
  for (let slot = 1; slot <= 9; slot++) {
    const hit = cells.get(slot);
    out.push({
      slot,
      candidates: hit ? [{
        key: hit.hero.key, name: hit.hero.name, faction: hit.hero.faction,
        arm: hit.hero.arm, variant: hit.hero.variant,
        score: Math.round(hit.score * 1000) / 1000,
      }] : [],
    });
  }
  return out;
}

module.exports = {
  enabled, available, identify, resetCache,
  _splitK: splitK, _boundsOf: boundsOf, _bucket: bucket, _sim: sim, _region: REGION,
};
