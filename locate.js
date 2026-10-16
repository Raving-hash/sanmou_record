// 九宫格定位器：算出「我的比赛阵容」那 9 个格子在哪。
//
// ── 为什么要有这个文件 ──
//
// recognize.js 里的 9 个框是**按竖屏手机截图写死的**（那里的 COLS/ROWS/CARD_W/CARD_H）。
// 2026-10-16 玩家核对回来 147 格，发现 24 张图里 **13 张是横屏**（PC / 平板 / 宽屏），
// 而「阵容配置」页在横屏下是**另一套版面**：「我的比赛阵容」在左半边横排三行，
// 每格是「小头像 + 三个战法名」，右边还有一整个武将仓库。
// 后果是横屏 117 格 **NCC 一个候选都拿不到** —— 两路一致恒为 0（置信度信号对一半以上的图
// 不存在），候选覆盖率只剩 8%（玩家想点都没得点，只能手输）。横屏的准确率其实更高
// （69% vs 62%），所以缺的不是"认得出"，是**第二路整个缺席**。
//
// ── 这里为什么是「坐标表」而不是「检测器」──
//
// 试过通用检测（阈值化 → 连通域 → 找 3×3 点阵），**放弃了**，别重走：
//   · 按 y 聚行时，左半边的阵容和右半边的仓库在**同一水平带**，一行永远不止三列；
//     改成二维单链聚类，两块又被并成一坨；
//   · 一共五个以上要调的旋钮（内容阈值、块面积上下限、长宽比、聚类距离、行列容差），
//     阈值一动结果就散，9 张测试图一张都没过；
//   · 按面积挑最大的块也不行 —— 竖屏图里武将仓库的缩略图比阵容头像更大更多。
// 那个方案**不可解释、不可维护**，生产上还要面对无尽的新机型/新主题/新卡面。
// 坐标表则是"拿一张该族的截图量一次、加一行"，错了能一眼看出来是哪个数不对。
//
// ── 怎么加一族 ──
//
// 1. 拿该族的一张截图，用 .devlocal/reco-layout.js 印出来的框叠到图上（见那个文件头）；
// 2. 量出九个框真实的相对坐标，加进 LAYOUTS；
// 3. 重跑 .devlocal/reco-layout.js，看这一族的「NCC 有候选」涨了没有。**没涨就是量错了。**
//
// ⚠️ 现在**只有两族**：portrait（原来的常数，实测 82% 的格子有候选）和 landscape
//    （2026-10-16 在 2560×1152 / 2400×1080 两张上量出来、叠框目视确认）。
//    1.78 / 1.93 / 1.32 / 1.40 那几个异形比例会落到 landscape 这族、**相对坐标会漂**。
//    漂到不能用的时候**用能量尺量出来再补一行**，不要凭感觉猜。

const sharp = require('sharp');

// 每族的九个框（相对整图宽/高的比例）。
// ★ cols/rows 直接写成数组、不用 x0+dx*i 算 —— portrait 那三行是从 recognize.js 原样抄过来的，
//   写成算式会引入舍入差，把已经验证过的基线悄悄挪走。
const LAYOUTS = [
  {
    name: 'portrait',                     // 手机竖屏（宽/高 < 1）
    max: 1.0,
    cols: [0.0441, 0.3360, 0.6270],       // == recognize.js 的 COLS
    rows: [0.528, 0.623, 0.718],          // == recognize.js 的 ROWS
    cw: 0.132, ch: 0.057,                 // == recognize.js 的 CARD_W / CARD_H
  },
  {
    name: 'landscape',                    // PC / 平板 / 宽屏（宽/高 >= 1）
    max: Infinity,
    cols: [0.155, 0.290, 0.425],
    rows: [0.170, 0.390, 0.610],
    // ⚠️ cw **只框住头像本身，不要框整个格子**。横屏每格是「小头像 + 三个战法名」的长条，
    //    框整个格子的话（cw=0.080）框里一半是字，而工作尺度是按框宽反推的 ——
    //    框越宽、工作图越小，头像反而被缩到模板比它还大。0.060 是头像 + 一点余量。
    cw: 0.060, ch: 0.110,
  },
];

// 按宽高比挑一族。**边界是 1.0 不是别的数**：游戏 UI 是按设备方向切换版面的，
// 竖屏（宽<高）一套、横屏（宽>高）另一套。（一开始我按 1.60 分会把 1320×998 和
// 433×309 这两张横屏版面的图错分到竖屏去。）
function pickLayout(ratio) {
  return LAYOUTS.find((l) => ratio < l.max) || LAYOUTS[LAYOUTS.length - 1];
}

// 一族坐标 + 图尺寸 → 九个框。形状与 recognize.slots() **完全一致**
// （{slot, team, left, top, width, height}，原图像素），所以下游的
// merge() / 写库 / 界面画框一行都不用改。
function boxesFor(layout, width, height) {
  const out = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push({
        slot: r * 3 + c + 1,                       // 行优先：部队一 1-3、二 4-6、三 7-9
        team: r + 1,
        left: Math.round(layout.cols[c] * width),
        top: Math.round(layout.rows[r] * height),
        width: Math.round(layout.cw * width),
        height: Math.round(layout.ch * height),
      });
    }
  }
  return out;
}

// 给一张图，返回 { boxes, layout } ；拿不到尺寸等任何意外都返回 null，
// **调用方回退 recognize.slots()** —— 定位失败时行为与从前一模一样（零回归）。
//
// ⚠️ 这里读尺寸的方式**必须和 recognize.js:177 一模一样**（`sharp(input).metadata()`，
//    不加 `.rotate()`）。两边只要有一点不一致，算出来的框就会和裁窗口时差一截。
//    EXIF 旋转这里只用来判方向（orientation 5~8 表示被转了 90°，宽高得对调着看），
//    不去改像素 —— 截图的 orientation 基本都是 1，真转了的那是另一个老问题。
async function locate(input) {
  let meta;
  try {
    meta = await sharp(input).metadata();
  } catch {
    return null;
  }
  const { width, height } = meta;
  if (!width || !height) return null;

  const turned = meta.orientation >= 5 && meta.orientation <= 8;   // 5..8 = 转了 90/270
  const w = turned ? height : width;
  const h = turned ? width : height;

  const layout = pickLayout(w / h);
  return { boxes: boxesFor(layout, width, height), layout, layoutName: layout.name };
}

module.exports = { locate, pickLayout, boxesFor, LAYOUTS };
