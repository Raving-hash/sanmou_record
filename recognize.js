// 阵容识别：从玩家上传的阵容截图里，认出三支部队共 9 个武将。
//
// 用途见 README「阵容识别」一节。这里只做**识别本身**，不管排队和存库
// （那些在 recognize-worker.js）。
//
// ── 这个文件里的常数是怎么来的（2026-10-16 用 uploads/ 里的真图量出来的）──
//
// 「阵容配置」页的「我的比赛阵容」区是**固定的 3 行 × 3 列**，
// 位置按整图的宽高比算就够准 —— 四张不同宽度（1080/1134/1152/1190）、
// 不同滚动位置的截图，9 个框全部落在武将卡上：
//
//     列 x = 4.41% / 33.60% / 62.70%   （乘图宽）
//     行 y = 52.8% / 62.3%  / 71.8%    （乘图高）
//     卡  = 13.2% × 5.7%（宽 × 高）
//
// ⚠️ 只有「阵容配置」页长这样。玩家要是传了排行榜截图或者 PC 端截图，
//    这 9 个框会落在别的东西上 —— 所以**界面上必须把框画给玩家看**，
//    让他一眼发现不对（见 views/partials/reco.ejs）。
//
// ── 匹配本身 ──
//
// 灰度归一化互相关（NCC），多尺度取最大。三条经验，都是踩出来的：
//
//  1. **只在卡框里搜，别整图自由滑窗**。整图滑会撞上「战法文字区」热点 ——
//     一个位置能让七八个毫不相干的武将同时拿 0.6+，相关系数被"哪儿都像"的区域骗了。
//     限定在卡框内之后，首位命中率从 3/11 涨到 6/9。
//  2. **模板必须有下限尺寸**。让尺度自由浮动的话，优化器一定挑最小那个
//     （小模板撞高分最容易），分数全是噪声。禁掉小尺寸，区分度才出来。
//  3. **取头像区、不取整卡**。整卡带着名字条和角标，这些"所有卡都一样"的部分
//     会稀释相关性。只取头像区能把真阳从 0.69 抬到 0.85。
//
// 实测精度（13 张真图里挑的样本）：**首位命中 6/9，前 3 名内含 8/9**。
// 不够全自动，所以产品形态是「给候选让玩家点」而不是「直接写死」。

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const DIR = path.join(__dirname, 'herodata');
const INDEX = path.join(DIR, 'index.json');

// 卡框（相对整图，见文件头）
const COLS = [0.0441, 0.3360, 0.6270];
const ROWS = [0.528, 0.623, 0.718];
const CARD_W = 0.132, CARD_H = 0.057;

// 官方卡上取哪一块当模板：去掉左上角标（上 4%）和底部名字条，取头肩那片。
// 宽度按比例留中间 68%，避开左右卡边。
const REGION = { x: 0.16, y: 0.04, w: 0.68, h: 0.43 };

// 搜索用的工作宽度。原图 1134 宽时卡约 150px，缩到 540 → 卡约 71px，
// 模板落在 46~72px 这个区间（实测这个区间才分得开）。
const WORK_W = 540;
const SIZES = [46, 58, 72];
const MIN_SIZE = 36;          // 模板下限，见文件头第 2 条
const STRIDE = 2;
// 分数下限。真实匹配落在 0.5~0.8，假阳在 0.4 上下，而"这张图不是阵容配置页"
// 时 bestScore 会返回哨兵 -1（没有任何窗口可比较）。
// ★ 没有这个下限会出大丑：贪心分配会把 -1 也当分数发牌，
//   于是每一格都被塞上"库里按拼音排的前 9 个"（实测真发生了，见 2026-10-16 的开发站日志）。
const MIN_SCORE = 0.30;       // 进候选的门槛
const MIN_PICK = 0.40;        // 自动认下来的门槛（比候选严一档）
// 窗口标准差下限。低于这个值说明是块平坦区域（纯色背景），
// 拿它算相关系数会炸出 1.0 以上的假分。
const MIN_WSD = 10;

let cache = null;             // { heroes, templates }

const available = () => fs.existsSync(INDEX);

// 灰度 + 原始像素
async function rawGray(input, extract) {
  let p = sharp(input);
  if (extract) p = p.extract(extract);
  const { data, info } = await p.greyscale().raw().toBuffer({ resolveWithObject: true });
  return { d: Float32Array.from(data), w: info.width, h: info.height };
}

// 零均值单位方差。NCC 的前提：两边都归一化，相关系数才落在 [-1,1]。
function normalize(d) {
  const n = d.length;
  let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { s += d[i]; s2 += d[i] * d[i]; }
  const m = s / n;
  const sd = Math.sqrt(Math.max(s2 / n - m * m, 1e-6));
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) o[i] = (d[i] - m) / sd;
  return o;
}

// 最近邻缩放。缩放之后**必须重新归一化** —— 采样会改变方差，
// 不重新归一化的话算出来的就不是相关系数了（曾经因此拿到 1.86 这种不可能的值）。
function rescale(t, w, h) {
  const o = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(t.h - 1, (y * t.h / h) | 0) * t.w;
    for (let x = 0; x < w; x++) {
      o[y * w + x] = t.d[sy + Math.min(t.w - 1, (x * t.w / w) | 0)];
    }
  }
  return { d: normalize(o), w, h };
}

// 在 S 里滑模板 T，返回最高分
function bestScore(S, T) {
  const sw = S.w, sh = S.h, tw = T.w, th = T.h;
  if (tw > sw || th > sh) return -1;
  const n = tw * th;
  let best = -1;
  for (let y = 0; y + th <= sh; y += STRIDE) {
    for (let x = 0; x + tw <= sw; x += STRIDE) {
      let sum = 0, s2 = 0, dot = 0;
      for (let j = 0; j < th; j++) {
        const so = (y + j) * sw + x, to = j * tw;
        for (let i = 0; i < tw; i++) {
          const v = S.d[so + i];
          sum += v; s2 += v * v; dot += v * T.d[to + i];
        }
      }
      const m = sum / n, wsd = Math.sqrt(Math.max(s2 / n - m * m, 0));
      if (wsd < MIN_WSD) continue;         // 平坦块，跳过
      const s = (dot / n) / wsd;
      if (s > best) best = s;
    }
  }
  return best;
}

// 把 102 张卡面读进来做成模板。**每张卡的每个尺度只算一次**，
// 之后所有图共用 —— 这是整个流程里最贵的一步，只做一次。
async function load() {
  if (cache) return cache;
  if (!available()) return null;
  const idx = JSON.parse(fs.readFileSync(INDEX, 'utf8'));
  const templates = [];
  for (const h of idx.heroes) {
    const file = path.join(DIR, h.img);
    if (!fs.existsSync(file)) continue;
    const m = await sharp(file).metadata();
    const base = await rawGray(file, {
      left: Math.round(m.width * REGION.x), top: Math.round(m.height * REGION.y),
      width: Math.round(m.width * REGION.w), height: Math.round(m.height * REGION.h),
    });
    const norm = { d: normalize(base.d), w: base.w, h: base.h };
    const sizes = SIZES
      .filter((w) => w >= MIN_SIZE && w < WORK_W)
      .map((w) => rescale(norm, w, Math.round(w * base.h / base.w)));
    templates.push({ hero: h, sizes });
  }
  cache = { heroes: idx.heroes, templates };
  return cache;
}

// 九宫格的卡框（相对坐标 → 像素），导出去给界面画框用
function slots(width, height) {
  const out = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push({
        slot: r * 3 + c + 1,
        team: r + 1,
        left: Math.round(COLS[c] * width),
        top: Math.round(ROWS[r] * height),
        width: Math.round(CARD_W * width),
        height: Math.round(CARD_H * height),
      });
    }
  }
  return out;
}

// 主入口：给一张图（Buffer 或路径），返回 9 个格子各自的候选
// 返回 [{ slot, candidates: [{key,name,faction,arm,variant,score}] }]
async function recognize(input, topN = 3) {
  const lib = await load();
  if (!lib) throw new Error('herodata/ 不在，识别未启用');
  const meta = await sharp(input).metadata();

  // 整图缩到工作宽度，之后所有卡框都在这个尺度上算
  const k = WORK_W / meta.width;
  const { data, info } = await sharp(input).greyscale().resize({ width: WORK_W })
    .raw().toBuffer({ resolveWithObject: true });
  const S = { d: Float32Array.from(data), w: info.width, h: info.height };

  // 先把 9 个格子 × 102 张卡的分数全算出来，再统一分配。
  // **不能在每个格子里各挑各的第一名** —— 同一套阵容 9 个武将必然互不相同，
  // 各挑各的会出现"两格都认成诸葛亮"（实测真发生了），
  // 而加上"互不相同"这条约束能把这种错挤掉。
  const boxes = slots(meta.width, meta.height);
  const matrix = [];          // matrix[i][j] = 第 i 格、第 j 张卡的分
  for (const box of boxes) {
    const ex = {
      left: Math.round(box.left * k), top: Math.round(box.top * k),
      width: Math.round(box.width * k), height: Math.round(box.height * k),
    };
    // 裁出这张卡的窗口。**留一点余量**（pad）—— 卡框是比例算出来的，
    // 不保证像素级精确，留余量让模板有地方对齐。
    const pad = 6;
    const cx = Math.max(0, ex.left - pad), cy = Math.max(0, ex.top - pad);
    const cw = Math.min(S.w - cx, ex.width + pad * 2), ch = Math.min(S.h - cy, ex.height + pad * 2);
    const win = { d: new Float32Array(cw * ch), w: cw, h: ch };
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) win.d[y * cw + x] = S.d[(cy + y) * S.w + (cx + x)];
    }
    // ⚠️ 窗口**不要**预先归一化。bestScore 会自己减均值除标准差来算相关系数，
    //    而 MIN_WSD 那个平坦区下限是按 0~255 的原始灰度标定的 ——
    //    先把窗口归一化（标准差变成 ~1）会让**每一块**都被判成平坦区而全部跳过，
    //    表现就是所有分数都是 -1。归一化的只有模板。

    const row = lib.templates.map((t) => {
      let best = -1;
      for (const sz of t.sizes) {
        const s = bestScore(win, sz);
        if (s > best) best = s;
      }
      return best;
    });
    matrix.push(row);
  }

  // 贪心分配：按分数从高到低，格子空着、武将也没被别的格子占用，就配上去。
  // 不是最优解（最优要匈牙利算法），但 9×102 这个规模上贪心和最优几乎没差别，
  // 而且这段代码得能一眼看懂 —— 认错了是要人去查的。
  const pairs = [];
  for (let i = 0; i < matrix.length; i++) {
    for (let j = 0; j < matrix[i].length; j++) {
      // ★ 够不到门槛的**根本不参与分配**。放它们进来的话，一张完全没识别出来的图
      //   （所有分数都是哨兵 -1）会让每一格都分到一个武将 —— 而且是按库里拼音顺序
      //   从头发的牌，看起来像模像样，全是错的。
      if (matrix[i][j] < MIN_PICK) continue;
      pairs.push({ i, j, s: matrix[i][j] });
    }
  }
  pairs.sort((a, b) => b.s - a.s);
  const assigned = new Array(matrix.length).fill(null);
  const taken = new Set();
  for (const p of pairs) {
    if (assigned[p.i] !== null || taken.has(p.j)) continue;
    assigned[p.i] = p.j;
    taken.add(p.j);
  }

  return boxes.map((box, i) => {
    // 候选 = 本格的头名，再补几个"没被别的格子占用"的高分卡。
    // 后补的这几个很重要：玩家要纠正的时候，正确那个武将得在选项里够得着。
    const pool = [];
    for (let j = 0; j < matrix[i].length; j++) {
      if (j === assigned[i]) continue;
      if (taken.has(j)) continue;               // 已被别的格子认走，不重复推荐
      if (matrix[i][j] < MIN_SCORE) continue;   // 够不到门槛的连候选都不当
      pool.push(j);
    }
    pool.sort((a, b) => matrix[i][b] - matrix[i][a]);
    const picks = [assigned[i], ...pool.slice(0, topN - 1)].filter((j) => j !== null && j !== undefined);
    return {
      slot: box.slot, team: box.team, box,
      candidates: picks.map((j) => {
        const h = lib.templates[j].hero;
        return { key: h.key, name: h.name, faction: h.faction, arm: h.arm, variant: h.variant,
          score: Math.round(matrix[i][j] * 1000) / 1000 };
      }),
    };
  });
}

// 把两路识别的结果合起来，决定**自动填哪个**、以及**可信不可信**。
//
// ★ 为什么"一致"能当置信度用：2026-10-16 在玩家标注过的 63 格真值上实测 ——
//   两路头名一致的 28 格（44%）**28/28 全对**；不一致的 56% 里 VLM 对 19、NCC 对 13、都错 3。
//   所以：一致 → 直接填、标 high；不一致 → 填 VLM 的（它更准），标 low。
//   注意低置信**也照填**（用户定的"照填 + 标待核对"），不是留空。
//
// 这是纯函数（不碰库、不联网），**断言直接喂假数据进来测** —— 见 .devlocal/test/test-heroes.js。
//
// 返回的每一项正好是 db.saveGuesses 要的形状。
function merge(nccList, vlmList) {
  const nccBySlot = new Map();
  for (const s of nccList || []) nccBySlot.set(s.slot, s.candidates || []);
  const vlmBySlot = new Map();
  for (const s of vlmList || []) vlmBySlot.set(s.slot, s.candidates || []);

  const out = [];
  for (let slot = 1; slot <= 9; slot++) {
    const ncc = nccBySlot.get(slot) || [];
    const vlm = vlmBySlot.get(slot) || [];
    const nccKey = ncc[0] ? ncc[0].key : null;
    const vlmKey = vlm[0] ? vlm[0].key : null;

    let auto_key = null, confidence = null;
    if (nccKey && vlmKey) {
      auto_key = vlmKey;                                    // 一致时两个都一样，写谁都行
      confidence = nccKey === vlmKey ? 'high' : 'low';
    } else if (vlmKey) {
      auto_key = vlmKey; confidence = 'low';                // NCC 一无所获（卡框没对上、图不是那个页）
    } else if (nccKey) {
      auto_key = nccKey; confidence = 'low';                // VLM 没跑或跑挂了 —— 降级，但必须标出来
    }

    out.push({ slot, candidates: ncc, vlm, auto_key, confidence });
  }
  return out;
}

module.exports = { available, load, recognize, merge, slots, COLS, ROWS, CARD_W, CARD_H };

// 命令行自测：node recognize.js <图片路径>
// 打印 9 个格子的前 3 个候选，人眼核对用（断言里不跑这个，见 README）
if (require.main === module) {
  const file = process.argv[2];
  if (!file) { console.log('用法: node recognize.js <图片路径>'); process.exit(1); }
  recognize(file).then((r) => {
    for (const s of r) {
      const c = s.candidates.map((x) => `${x.name}(${x.faction}·${x.arm}) ${x.score.toFixed(3)}`).join('  ');
      console.log(`部队${s.team} 第${(s.slot - 1) % 3 + 1} 位: ${c}`);
    }
  }).catch((e) => { console.error(e.message); process.exit(1); });
}
