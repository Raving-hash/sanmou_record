#!/usr/bin/env node
// 把游戏里「州内积分赛排行榜」整屏截图 → 识别 → 去重 → 传给后端。
//
//   node scripts/rank-shot.js --from data/rank-shots/2026-10-18-1410   # 只解析已抓的帧
//   node scripts/rank-shot.js --capture                                # 激活窗口→抓→滚→再抓…
//   node scripts/rank-shot.js --capture --post http://host/api/rank    # 认完再发给后端
//   node scripts/rank-shot.js --capture --payload out.json             # 只把要发的报文写出来
//
// 旋钮：--title <正则>  --notches <每屏滚几格>  --frames <最多几屏>  --out <目录>
//       --mode gdi|screen（默认 screen：直接截屏幕，窗口必须在最前面）
//       --post <url> / --token <t> / --payload <file>
//       --batch-size <n>（一个包最多几条写法，默认 0 = 全塞进一个请求）
//       --no-navigate（别重进排行榜，就抓现在这一页）
//       --score-grow <n>（每跑一轮再多加 n，试跑用）  --score-add <n>（固定加 n）
//       --score-reset（把累加轮次清零）  --prune <n>（只留最近 n 轮抓取目录）
//       --probe（把每个词框打出来，核对列切分用）  --debug（每一遍各自切出来的行）
//
// ── 抓之前先自己重进一次排行榜（--capture 默认就这么做） ──
//
// 排行榜页面是**进入那一刻**的数据，停在那儿不重进，抓到的就是上次的旧数。
// 所以每次开抓之前走三步（全程自己判断，认不出来就不点）：
//   ① 如果现在在排行榜页 → 点左上角箭头，回演武大会；
//   ② 在演武大会 → 点左下角「排行榜」，重进（这一步刷新数据）；
//   ③ 截一屏确认真的进到排行榜了，再交给下面的抓屏/滚动。
// 箭头是图形没有文字，按量好的比例点：(0.069, 0.043)；「排行榜」按钮优先靠 OCR
// 找到那三个字再点，只有在确认是演武大会页时才会退回按比例点。--no-navigate 关掉。
//
// 这两步和滚轮一样是**注入输入**，所以同样受 UIPI 那条限制（见 install-rank-task.ps1）。
//
// ── 发给后端的报文（2026-10-18 用真实接口核过） ──
//
//   POST <--post 给的地址>          Content-Type: application/json
//   Authorization: Bearer <--token>（给了 token 才带）
//
//   [ { "game_name": "善丨路飞王", "score": 84 }, { "game_name": "善丨大葱王", "score": 59 } ]
//
// **裸数组**，不是 {"rows": …}（包装过的写法对端一律当成"game_name 不能为空"）。
// 回执：{"ok":true,"season":"测试","updated":1,"results":[{"game_name":…,"score":…,
//         "status":"ok"|"unknown","user_id":…,"previous":…,"changed":true}]}
// results[] 与请求等长同序，名字对不上时**照样 200**，所以只能看 status 才知道写没写。
//
// 只有这两个字段：一句"把游戏名和积分传过去"就该这么简单。名次、杀敌、战绩、
// 每一屏的原图都留在本地 rows.json 里，后端要再说，别提前塞进去把契约搞复杂。
// 没认出积分的行**不发**（宁缺：少一个人，比给某人写个 0 分好）。
// 同一次抓取里同一个游戏名只会出现一次（已经按名次去重过了）。
//
// 一次全发而不是逐行重试：一个名字要对上得试好几种写法（原样 / 去掉 [阵营] /
// 竖线两种），逐行发就是「78 行 × 4 种写法 ≈ 300 个请求 × 0.5s ≈ 140 秒」，
// 同样的信息装进一个数组只花一次往返（实测 301 条一包仍 200）。
//
// ── 为什么这条路能成（2026-10-18 实测） ──
//
// 排行榜是**固定版式的表格**：6 行/屏、行距恒定、列与列之间空着 140px 以上。
// 所以这里几乎不摆坐标常量：
//   · 行 = 按 y 聚类（同一行的字几乎同高）；
//   · 列 = 按 x 的空隙切（列间距 140px，格子内部的字缝不到 20px）；
//   · 行身份 = **名次列**，不靠"这是第几行"——所以滚多少、滚到哪一屏都无所谓。
// 和 recognize-ocr.js 那条「拿文字当定位器，别先按坐标裁窗」是同一个道理。
//
// 识别用 **Windows 自带的 OCR**（Windows.Media.Ocr，中文包随系统就有）：
// 不连 OCR_URL 那个服务、不联网、不装依赖。取的是**词框**不是行框 —— 行会把
// 同一基线上的姓名/战绩/积分粘成一条，列就分不开了。
//
// ── 两遍 OCR 取并集（这不是保险，是必须的） ──
// 1 倍：名次那几枚金牌上的数字认得出来，但第 1 名的积分 84 会丢；
// 2 倍：积分全对，反而 1/2/3 名的名次全丢。
// 两遍并起来才是六行全对，代价是每屏多 1 秒左右。见 win-ocr.ps1 的 $Scale 注释。
//
// ── 它不做什么 ──
// 不写库、不碰站点。只把「游戏名 + 积分」这一件事交出去（--post / --payload），
// 谁收、怎么对上站点账号，是后端那一步的事。

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// Windows 自带的 PowerShell 5.1（.NET Framework 4.8）才有 WinRT 投影；
// pwsh 7 跑在 .NET 8 上，[Windows.Media.Ocr.*] 根本解析不出来。别换。
const PS5 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const HERE = __dirname;

const ROW_TOL = 45;                    // 行聚类容差（1920 宽下量的，字高 31）
const COL_GAP = 45;                    // 列切分容差（列间距 140+，字缝 20-）
const SCALES = [1, 2];                 // 两遍 OCR 的放大倍数
// 杀敌/积分相对「战绩」那一块的落点窗口（起点距，1920 宽下量的）。
// 底下这些数字只是**排除法**用的：头像上偶尔会被认出一个 0，绝不能让它顶替积分。
const KILL_OFFSET = [120, 380];        // 战绩.x + 这些 → 才是杀敌列
const SCORE_OFFSET = [120, 380];       // 杀敌.x + 这些 → 才是积分列
// 滚动节拍（见 captureAdaptive）：每步想前进几行、滚完等多久。
// 目标必须小于每屏 6 行，留出重叠，否则漏一行就再也补不回来（"名次断档"会喊）。
const SCROLL_TARGET_ROWS = 4;

// 读仓库根上的 .env（只补环境里没有的键）。这台 Windows 机器用它放
// SCORE_API_URL / SCORE_API_TOKEN；服务器上的那份 .env 是另一回事，互不影响。
// 自己写两行解析，不引 dotenv —— 这个脚本连 node_modules 都不该依赖。
function loadEnvFile() {
  const p = path.join(HERE, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[2] === '') continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadEnvFile();
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const FROM = opt('--from', '');
const CAPTURE = flag('--capture');
const TITLE = opt('--title', '谋定天下');
const FRAMES = Number(opt('--frames', 20));
const NOTCHES = Number(opt('--notches', 3));
const SCROLL_SETTLE_MS = Number(opt('--settle', 1200));   // 滚完等多久再抓（游戏那侧有滚动节流）
const NO_SCROLL = flag('--no-scroll');
// --watch：不模拟输入，用户自己滚，工具只负责连拍 + 去重。
// 这条路和窗口权限无关 —— 游戏是管理员权限跑的时候，这是唯一能用的模式（见 capture()）。
// 间隔 2 秒：榜单背景有呼吸光效，帧与帧本来就不一样，截太快只会攒一堆同一屏的画面。
const WATCH = flag('--watch');
const WATCH_SECONDS = Number(opt('--seconds', 90));
const WATCH_INTERVAL = Number(opt('--interval', 2000));
const MODE = opt('--mode', 'screen');
const PROBE = flag('--probe');
// 抓之前先"回大厅 → 点排行榜"重进一次：排行榜是进页面那一刻的数据，
// 停在那儿不重进就是上次的旧数。--no-navigate 关掉。
const NAVIGATE = !flag('--no-navigate');
// 返回箭头没有文字，只能按位置点。这两个数是拿你给的两张 1920×1032 截图上量出来的
// 比例（客户区 1920×1009，所以 y 要减掉 23px 标题栏）：
//   箭头中心 ≈ (132, 66) → 客户区 (132, 43) → (0.069, 0.043)
//   排行榜按钮文字中心 ≈ (463, 953) → 客户区 (463, 930) → (0.241, 0.921)（只在认不出文字时兜底）
const BACK_AT = (opt('--back-at', '0.069,0.043')).split(',').map(Number);
const HALL_BTN_AT = (opt('--hall-btn-at', '0.241,0.921')).split(',').map(Number);
// 交给后端那一步。地址待定，所以三种都给：
//   --post <url>    直接发（也可以走环境变量 RANK_IMPORT_URL / RANK_IMPORT_TOKEN）
//   --payload <f>   只把报文写出来，不发 —— 后端还没好时拿这个对字段
//   （都不给）      只在本地出表，和从前一样
const POST = opt('--post', process.env.SCORE_API_URL || process.env.RANK_IMPORT_URL || '');
const TOKEN = opt('--token', process.env.SCORE_API_TOKEN || process.env.RANK_IMPORT_TOKEN || '');
const PAYLOAD = opt('--payload', '');
const POST_TIMEOUT_MS = Number(opt('--post-timeout', 20000));
// 一个包最多装几条写法（0 = 全塞进一个请求）。接口是裸数组、实测 301 条也正常，
// 所以默认一个包；只有对端 body 上限比这还小才需要 --batch-size 切片。
const BATCH_SIZE = Number(opt('--batch-size', 0));

// ── 试跑用的积分偏移（都默认 0 = 发真实积分） ──
//   --score-grow <n>  每真发一轮，在真实积分上再多叠 n（累加，跨进程记账）
//   --score-add  <n>  只这一轮固定加 n
// 为什么默认按累加设计：真实积分不变时，固定偏移的第二轮就会被后端判成"分数没变"，
// 网页上根本看不出这一轮跑过 —— 而 2026-10-18 用户要的正是"每 3 分钟把实际积分
// +100，方便观测积分在更新"。累加才看得见每一轮。
const SCORE_GROW = Number(opt('--score-grow', 0));
const SCORE_ADD = Number(opt('--score-add', 0));
const SCORE_RESET = flag('--score-reset');
// 每 3 分钟一轮、一轮 ~25MB 帧图，一天就能把盘塞满。只留最近 N 轮目录。
const PRUNE_KEEP = Number(opt('--prune', 0));
const SHOTS_ROOT = path.join(HERE, '..', 'data', 'rank-shots');
const OFFSET_STATE = path.join(SHOTS_ROOT, '.offset-state.json');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
const OUT = path.resolve(opt('--out', path.join(HERE, '..', 'data', 'rank-shots', stamp)));

// ── PowerShell 桥 ──
// stdio 全程 ignore：要的东西都落在磁盘上（PNG + words.jsonl），不走管道。
// 受限沙箱里 Node 抓子进程 stdout 会踩 spawn EPERM，这样绕开那道墙。
function ps(script, args) {
  const r = spawnSync(PS5, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, script), ...args],
    { stdio: 'ignore' });
  if (r.status !== 0) throw new Error(`${script} 失败（退出码 ${r.status}）`);
}

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const isNum = (s) => /^\d+$/.test(s);

// ── 解析一屏（**一遍 OCR** 的词框；两遍各自解析，最后按行投票） ──
// 两遍的词框不能先取并集再切列：同一个数字两次切法不同（"271|31|1" 对 "2713|11"），
// 并起来会把数字接成 "27171311"。所以合并放在**解析之后**、按字段投票。
//
// words: [{text,x,y,w,h}]，坐标是 PNG 内的像素（两路截图都以客户区为原点，可比）
function parseScreen(words, width) {
  // 头像/图标上偶尔被认出一个又宽又高的"字"（实测见到 83×66 的 "0"），
  // 它会把姓名或积分顶掉。文字框的高度都在字高附近，按中位数挡掉超标的。
  const hs = words.map((w) => w.h).sort((a, b) => a - b);
  const medH = hs[hs.length >> 1] || 30;
  const items = words
    .filter((w) => w.h <= medH * 1.8 && w.w <= medH * 6)
    .map((w) => ({ ...w, cy: w.y + w.h / 2 }))
    .sort((a, b) => a.cy - b.cy);
  if (!items.length) return { rows: [], warns: ['这一屏一个字都没认出来'] };

  // ① 行：y 相邻差超过容差就另起一行。容差按字高中位数放大，字号变了也跟得上。
  const tol = Math.max(18, medH * 1.4);
  const lines = [];
  for (const it of items) {
    const cur = lines[lines.length - 1];
    if (!cur || it.cy - cur.cy > tol) lines.push({ cy: it.cy, items: [it] });
    else { cur.items.push(it); cur.cy = (cur.cy * (cur.items.length - 1) + it.cy) / cur.items.length; }
  }

  // ② 列：行内按 x 排序，空隙超过 COL_GAP 就切一块。
  const k = width / 1920;                       // 窗口比 1920 宽/窄时按比例放缩上面那些窗口
  const rows = [];
  const warns = [];
  for (const line of lines) {
    const ws = line.items.sort((a, b) => a.x - b.x);
    const groups = [];
    for (const w of ws) {
      const g = groups[groups.length - 1];
      const prev = g && g[g.length - 1];
      if (!g || w.x - (prev.x + prev.w) > COL_GAP) groups.push([w]);
      else g.push(w);
    }
    const cell = (g) => g.map((w) => w.text).join('');
    const startOf = (g) => g[0].x;

    // ③ 用「战绩」这块当锚点认行：它的形态（N胜M负）不会认错，
    //    而名次那几个数字印在奖牌上，最不可靠 —— 不能拿它当"这行是不是数据行"的判据。
    const recIdx = groups.findIndex((g) => /^\d{1,2}[胜负負]\d{1,2}[负負]$/.test(cell(g)));
    if (recIdx < 1) continue;                   // 表头、顶栏、「我的排名」那一行都在这里出局

    // 名次列：最左那块，且必须是纯数字；认不出（奖牌上的字）就留 null，后面按顺序补
    const hasRank = isNum(cell(groups[0])) && groups[0].length === 1;
    const rank = hasRank ? Number(cell(groups[0])) : null;
    const name = cleanName(groups.slice(hasRank ? 1 : 0, recIdx).map(cell).join(''));

    const rec = cell(groups[recIdx]).match(/^(\d{1,2})[胜负負](\d{1,2})[负負]$/);
    const row = {
      rank,
      name,
      record: cell(groups[recIdx]),
      wins: rec ? Number(rec[1]) : null,
      losses: rec ? Number(rec[2]) : null,
      kills: null,
      score: null,
      y: line.cy,
    };

    // ④ 杀敌、积分：只认落在各自列窗口里的那一块。
    //    头像区偶尔会冒出一个 0，用窗口把它挡在外面 —— 否则那个 0 会顶替掉积分。
    const recX = startOf(groups[recIdx]);
    const numGroups = groups.slice(recIdx + 1).filter((g) => isNum(cell(g)));
    const within = (g, from, win) => {
      const d = (startOf(g) - from) / k;
      return d > win[0] && d < win[1];
    };
    const killG = numGroups.find((g) => within(g, recX, KILL_OFFSET));
    if (killG) row.kills = Number(cell(killG));
    const scoreG = killG && numGroups.find((g) => g !== killG && startOf(g) > startOf(killG) && within(g, startOf(killG), SCORE_OFFSET));
    if (scoreG) row.score = Number(cell(scoreG));

    rows.push(row);
  }
  return { rows, warns };
}

// 名次补位：榜单严格 1,2,3… 连续，认不出的名次可以由邻行推出来 ——
// **但"邻行"要按行距算隔了几行，不能假定挨着**。行距恒定（实测 127px），
// 两行 y 差几倍行距，名次就差几。
//
// 这一条是吃过亏才写的。最初写成"屏首那行 = 下一行 - 1"，而某一屏第 2 行整行没认出来
// （战绩都没认出来，那行压根不存在）时，第 1 名就被算成了第 2 名，姓名和杀敌全挂错。
// 现在 302 到 556 差两个行距，就按"隔两行"推成 3-2=1；对不齐的一律不推 ——
// 宁可缺（"名次断档"会喊出来），不可错。
//
// 还要跑到不动为止：连着几行都没认出奖牌上的数字时，光扫一遍补不回来。
function inferRanks(rows) {
  if (rows.length < 2) return rows;
  const dys = [];
  for (let i = 1; i < rows.length; i++) dys.push(rows[i].y - rows[i - 1].y);
  const sorted = [...dys].sort((a, b) => a - b);
  const pitch = sorted[sorted.length >> 1] || 127;
  // b 比 a 低几行；y 差对不上整数倍行距就返回 null（说明中间被切坏了，别推）
  const rel = (a, b) => {
    const d = rows[b].y - rows[a].y;
    const n = Math.round(d / pitch);
    return n >= 1 && Math.abs(d - n * pitch) < pitch * 0.3 ? n : null;
  };
  const uniq = (arr) => [...new Set(arr)];

  const taken = new Set(rows.filter((r) => r.rank !== null).map((r) => r.rank));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].rank !== null) continue;
      const above = [];
      const below = [];
      for (let j = 0; j < i; j++) {
        const n = rel(j, i);
        if (rows[j].rank !== null && n !== null) above.push(rows[j].rank + n);
      }
      for (let j = i + 1; j < rows.length; j++) {
        const n = rel(i, j);
        if (rows[j].rank !== null && n !== null) below.push(rows[j].rank - n);
      }
      const a = uniq(above);
      const b = uniq(below);
      let r = null;
      if (a.length === 1 && b.length === 1) r = a[0] === b[0] ? a[0] : null;   // 两边必须一致
      else if (a.length === 1 && b.length === 0) r = a[0];
      else if (b.length === 1 && a.length === 0) r = b[0];
      if (r === null || r < 1 || taken.has(r)) continue;
      rows[i].rank = r;
      rows[i].inferred = true;
      taken.add(r);
      changed = true;
    }
  }
  // 一行整行没认出来，行距会露馅：这是最该让人知道的一种"缺"
  for (let i = 1; i < rows.length; i++) {
    const n = rel(i - 1, i);
    if (n !== null && n > 1) rows[i].gapAbove = n;
  }
  return rows;
}

// 名字前面挂的杂物要剥掉：名次那一列的数字没被认出来时，它会并进姓名格里
// （实测「19[云]龙文章」「0[云]星丨无敌狂」「、[云]善丨鬼油肉」都是这么来的）。
// 规则很窄：**只剥"纯数字/标点"前缀，而且剥完必须紧跟着 '['**，
// 所以「满仓将军」这种没有阵营括号的名字一个字都不会动。
function cleanName(s) {
  const m = String(s || '').match(/^[\s\d、，。．·*…《》「」【】()<>'"~\-_－—:：;；!！?？|｜]*(\[.*)$/);
  return m ? m[1] : String(s || '');
}
// 名字的归一化：只为了**比较**，不为了输出。
// 分隔符"丨"在两遍里会被认成 "|" 或丢掉，标点上偶尔还会冒出一个顿号 —— 不归一化
// 的话每一行都会被报成"名字不一致"，警告就没人看了。
const normName = (s) => String(s || '').replace(/[丨|｜︱]/g, '|').replace(/[\s、,.·'"]/g, '');

// 编辑距离：只给"名次没认出来那些行"查重用，名字都短（4~10 字），朴素实现足够。
// 已经有人的名字和它 ≥75% 像，就当是同一个人 —— OCR 把「秦」认成「剿」、
// 把「丨」吞掉之后，归一化救不了这种差异，只能模糊比。
function similar(a, b) {
  const m = a.length, n = b.length;
  if (!m || !n) return 0;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}
// ── 跨屏 + 跨遍合并：同一个名次的每一次观测都投一票 ──
// 一行通常被两屏各认一遍、每屏两遍 OCR，一共 4 票。取众数，
// 平票才报出来人工看 —— 这比"第一次出现就算数"稳得多，尤其是积分那两位数字。
function vote(values) {
  const counts = new Map();
  for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
  let best = null;
  let bestN = 0;
  let tie = false;
  for (const [v, n] of counts) {
    if (n > bestN) { best = v; bestN = n; tie = false; }
    else if (n === bestN) tie = true;
  }
  return { value: best, n: bestN, total: values.length, variants: [...counts.keys()], tie };
}

function merge(screens) {
  const obs = new Map();
  const orphans = [];
  const warns = [];
  for (const sc of screens) {
    const seenHere = new Set();
    for (const r of sc.rows) {
      if (r.rank === null) { orphans.push(r); continue; }
      // 同一屏出现两个同名次 = 补位补错或行被切重了，这一屏的票不能信
      if (seenHere.has(r.rank)) {
        warns.push(`${sc.label}：同一屏出现了两个第 ${r.rank} 名，这一屏已整体不采信`);
        sc.dirty = true;
      }
      seenHere.add(r.rank);
    }
  }
  for (const sc of screens) {
    if (sc.dirty) continue;
    for (const r of sc.rows) {
      if (r.rank === null) continue;
      if (!obs.has(r.rank)) obs.set(r.rank, []);
      obs.get(r.rank).push(r);
    }
  }

  const rows = [];
  for (const [rank, list] of [...obs.entries()].sort((a, b) => a[0] - b[0])) {
    const row = { rank };
    for (const key of ['name', 'record', 'wins', 'losses', 'kills', 'score']) {
      const vals = list.map((r) => r[key]).filter((v) => v !== null && v !== '');
      if (!vals.length) { row[key] = null; continue; }
      if (key === 'name') {
        // 名字按归一化后的形态投票，输出用出现最多的那个原始写法
        const forms = new Map();
        for (const v of vals) {
          const n = normName(v);
          const cur = forms.get(n) || { count: 0, raw: v };
          cur.count++;
          forms.set(n, cur);
        }
        const ranked = [...forms.entries()].sort((a, b) => b[1].count - a[1].count);
        const top = ranked[0];
        // 平票时优先带阵营括号的：头像上蹭出来的杂物（引号、顿号）不会以 '[' 开头
        const pick = ranked.length > 1 && ranked[0][1].count === ranked[1][1].count && !top[1].raw.startsWith('[')
          ? (ranked.find(([n]) => n.startsWith('[')) || top)
          : top;
        row[key] = pick[1].raw;
        if (ranked.length > 1 && ranked[0][1].count === ranked[1][1].count) {
          warns.push(`第 ${rank} 名的名字有 ${ranked.length} 种认法：${ranked.map(([n]) => n).join(' / ')}`);
        }
        continue;
      }
      const v = vote(vals);
      row[key] = v.value;
      if (v.total > 1 && v.variants.length > 1 && v.n === 1) {
        warns.push(`第 ${rank} 名的 ${key} 有 ${v.variants.length} 种认法：${v.variants.join(' / ')}`);
      }
    }
    row.observations = list.length;
    row.inferredRank = list.every((r) => r.inferred);
    rows.push(row);
  }

  const inferred = rows.filter((r) => r.inferredRank).length;
  if (inferred) warns.push(`${inferred} 行的名次是**按顺序推出来的**（奖牌上的字没认出来），名次本身没猜`);

  // 名次没认出来的行不丢：接口只要"游戏名 + 积分"，名次本来只是去重用的。
  // 按**归一化后的名字**去重，名次留空，照样算一个人。（实测有整屏的名次数字都没认出来的，
  // 那 7 个人如果丢掉，站上就少了 7 个人的分。）
  const seenNames = rows.map((r) => normName(r.name));
  const seenName = new Set(seenNames);
  const unranked = [];
  for (const o of orphans) {
    const key = normName(o.name);
    if (!key || seenName.has(key)) continue;
    // 已经有人在榜上了（只是那一行的名次没认出来），别重复算一个人
    if (seenNames.some((x) => similar(x, key) >= 0.75)) continue;
    seenName.add(key);
    seenNames.push(key);
    unranked.push({ ...o, rank: null, name: cleanName(o.name) });
  }
  if (unranked.length) {
    warns.push(`${unranked.length} 行的名次没认出来，按名字去重后仍然计入（名次空着）：${unranked.map((o) => o.name).join('、')}`);
  }
  rows.push(...unranked);

  const blank = rows.filter((r) => r.score === null);
  if (blank.length) warns.push(`${blank.length} 行的积分没认出来：${blank.map((r) => r.rank === null ? r.name : `第 ${r.rank} 名`).join('、')}`);

  // 名次断档 = 中间有一屏没抓到（滚太快/漏抓），这是最要命的错，必须喊出来
  const max = rows.length ? rows[rows.length - 1].rank : 0;
  const missing = [];
  for (let r = 1; r <= max; r++) if (!obs.has(r)) missing.push(r);
  if (missing.length) warns.push(`名次断档：缺 ${missing.slice(0, 20).join(',')}${missing.length > 20 ? ' …' : ''}`);
  return { rows, warns };
}

// ── 读帧：一帧 = 若干遍 OCR 的词框（s1、s2…） ──
function readFrames(dir) {
  const byFrame = new Map();
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.words.jsonl')).sort()) {
    const m = f.match(/^(.*?)(?:\.(s\d+))?\.words\.jsonl$/);
    if (!m) continue;
    const base = m[1];
    const tag = m[2] || 's1';
    const words = fs.readFileSync(path.join(dir, f), 'utf8')
      .split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l));
    if (!byFrame.has(base)) byFrame.set(base, {});
    byFrame.get(base)[tag] = words;
  }
  return [...byFrame.entries()].map(([base, tags]) => ({
    base,
    passes: Object.keys(tags).sort().map((t) => ({ tag: t, words: tags[t] })),
  }));
}

function printTable(rows) {
  const pad = (s, n) => {
    const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
    return String(s) + ' '.repeat(Math.max(0, n - w));
  };
  console.log(pad('名次', 5) + pad('姓名', 20) + pad('战绩', 9) + pad('杀敌', 9) + '积分');
  for (const r of rows) {
    console.log(pad(r.inferred ? `${r.rank}~` : r.rank, 5) + pad(r.name, 20) + pad(r.record, 9) +
      pad(r.kills === null ? '?' : r.kills, 9) + (r.score === null ? '?' : r.score));
  }
}

// PNG 宽从文件头读（IHDR 的 4 字节，大端）—— 只为按比例放缩列窗口，不值得为此解码整张图
// PNG 尺寸从 IHDR 里读（宽在偏移 16、高在 20，都是大端 4 字节）——
// 只为按比例放缩列窗口和点按位置，不值得为此解码整张图
function sizeOf(dir, file) {
  const b = fs.readFileSync(path.join(dir, file));
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// 抓 frames 屏（一屏一张 PNG），并把抓屏过程中的焦点问题报出来。
// 抓的是屏幕：窗口必须在最前面；滚轮又只发给**当前焦点窗口**，
// 所以没抢到焦点就立刻停手 —— 否则滚的是用户正在看的别的东西。
// 返回 true 表示注入输入被权限挡住了（这一轮只有一屏）。
function capture(dir, frames) {
  const args = ['-Action', 'capture', '-Title', TITLE, '-OutDir', dir,
    '-MaxFrames', String(frames), '-Notches', String(NOTCHES), '-Mode', MODE];
  if (WATCH) args.push('-Watch', '-IntervalMs', String(WATCH_INTERVAL), '-Seconds', String(WATCH_SECONDS));
  ps('win-rank.ps1', args);

  const logPath = path.join(dir, 'capture.log');
  if (!fs.existsSync(logPath)) return false;
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
  if (lines.includes('focus=refused')) {
    console.log('  ⚠ 没能把游戏窗口提到前台（多半是 Windows 的前台锁），抓到的可能是别的窗口');
  }
  if (lines.some((l) => l.startsWith('input-blocked'))) {
    console.log('  ⚠ 滚轮发不出去：游戏进程是**管理员权限**跑的，Windows 会把普通进程的模拟输入静默丢掉。');
    console.log('     两种走法：① 用管理员终端重跑这条命令；② 加 --watch —— 你自己滚，它只负责连拍。');
    return true;
  }
  const lost = lines.find((l) => l.startsWith('lost-foreground'));
  if (lost) console.log(`  ⚠ 滚动途中失去了焦点，已提前停手（${lost}）`);
  if (lines.includes('stopped: identical frame')) console.log('  已滚到底（连续两帧完全一样）');
  const watch = lines.find((l) => l.startsWith('watch stop'));
  if (watch) console.log(`  ${watch}`);
  return false;
}

// ── 自己滚着抓（边抓边看走了几行，从而校准滚多远） ──
//
// 为什么不能"固定滚 N 格抓一屏"：2026-10-18 第一次试运行，17 次滚轮事件
// （每次 4 格）只推进了 4 行 —— 游戏那边显然不是"一格一行"，而且它有自己的
// 滚动节流。固定的格数换个版本就白调，所以这里改成**量一量**：
// 每抓一屏，看上沿的名次比上一屏前进了几行（advance），
//   · advance > 目标 → 下次少滚点；
//   · advance < 目标 → 下次多滚点（最多 ×3，别一脚踩过头）；
//   · advance = 0     → 多滚一点并多等一会儿；连着三次还不动 = 到底了，收工。
// 每屏都留一张 PNG，最后再统一跑两遍 OCR 出表（跟踪用的那一遍只认 1 倍，省时间）。
function captureAdaptive(dir) {
  const tmpWords = path.join(dir, '_track.jsonl');
  let stepPx = SCROLL_TARGET_ROWS * 127;          // 初值：目标行数 × 行距（127px 是实测的行距）
  let settle = SCROLL_SETTLE_MS;
  let prevTop = null;
  let stale = 0;
  let shot = 0;
  let size = null;

  ps('win-rank.ps1', ['-Action', 'activate', '-Title', TITLE]);

  for (let i = 1; i <= FRAMES; i++) {
    const name = `frame-${String(i).padStart(2, '0')}.png`;
    const png = path.join(dir, name);
    ps('win-rank.ps1', ['-Action', 'shot', '-Title', TITLE, '-Out', png, '-Mode', MODE]);
    shot++;
    size = sizeOf(dir, name);
    ps('win-ocr.ps1', ['-Path', png, '-Out', tmpWords, '-Scale', '1']);
    const words = fs.existsSync(tmpWords)
      ? fs.readFileSync(tmpWords, 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l))
      : [];
    const rows = parseScreen(words, size.width).rows;
    const ranks = rows.map((r) => r.rank).filter((r) => r !== null);
    const top = ranks.length ? Math.min(...ranks) : null;
    const bottom = ranks.length ? Math.max(...ranks) : null;

    if (i === 1) {
      if (!rows.length) {
        console.log('  ✗ 第一屏认不出任何一行，停在这里（先确认游戏停在排行榜页）');
        process.exit(2);
      }
      console.log(`  第 1 屏：名次 ${top}–${bottom}，先往下拖 ${Math.round(stepPx)}px 试试`);
    } else if (prevTop !== null && top !== null) {
      const adv = top - prevTop;
      if (adv <= 0) {
        stale++;
        stepPx = Math.min(stepPx * 2 + 60, size.height * 0.6);
        settle += 300;
        console.log(`  第 ${i} 屏：没动（第 ${stale} 次）→ 下次拖 ${Math.round(stepPx)}px、等 ${settle}ms`);
        if (stale >= 3) { console.log('  连着三屏没动，当作到底了'); shot--; break; }
      } else {
        stale = 0;
        const k = SCROLL_TARGET_ROWS / adv;
        stepPx = Math.max(60, Math.min(size.height * 0.6, stepPx * (k > 1 ? Math.min(k, 3) : Math.max(k, 0.5))));
        settle = SCROLL_SETTLE_MS;
        console.log(`  第 ${i} 屏：名次 ${top}–${bottom}（前进了 ${adv} 行）→ 下次拖 ${Math.round(stepPx)}px`);
      }
    }

    if (i < FRAMES) {
      // 拖动，不用滚轮：实测滚轮不跟手（4 格=0 行、12 格=1 行、36/90 格=0 行）
      const x = Math.round(size.width / 2);
      const yFrom = Math.round(size.height * 0.80);
      const yTo = Math.max(Math.round(size.height * 0.16), Math.round(yFrom - stepPx));
      ps('win-rank.ps1', ['-Action', 'drag', '-Title', TITLE,
        '-X', String(x), '-Y', String(yFrom), '-X2', String(x), '-Y2', String(yTo), '-Steps', '14']);
      sleep(settle);
    }
    prevTop = top;
  }
  try { fs.unlinkSync(tmpWords); } catch { /* 没有就算了 */ }
  console.log(`  共抓 ${shot} 屏`);
}
// 跑一遍 OCR（所有放大倍数），清掉上一轮的词框
function probeDir(dir) {
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.words.jsonl')) fs.unlinkSync(path.join(dir, f));
  for (const s of SCALES) ps('win-ocr.ps1', ['-Dir', dir, '-Scale', String(s), '-Tag', `s${s}`]);
}

// ── 回大厅 → 点「排行榜」重进 ──
// 排行榜页面是**进入那一刻**的数据，停在上面不重进看到的就是旧数。所以每次跑之前：
//   ① 在排行榜页 → 点左上角箭头返回演武大会；
//   ② 在演武大会 → 点左下角「排行榜」重进（这一步会刷新数据）；
//   ③ 确认进到了排行榜，再交给抓屏那一套。
// 认不出当前是哪个界面就**什么都不点**，直接报错 —— 瞎点比不点危险得多。

// 词框按 y 聚成行、行内按 x 空隙聚成"标签"，返回 [{text, cx, cy, x, y, w, h}]。
// 和 parseScreen 分开写：那边是在切表格的列（容差 45），这边是在找按钮文字（容差更小）。
function labelsOf(words) {
  const items = words.map((w) => ({ ...w, cx: w.x + w.w / 2, cy: w.y + w.h / 2 }));
  const hs = items.map((i) => i.h).sort((a, b) => a - b);
  const medH = hs[hs.length >> 1] || 30;
  const tol = Math.max(12, medH * 1.2);
  const lines = [];
  for (const it of items.sort((a, b) => a.cy - b.cy)) {
    const cur = lines[lines.length - 1];
    if (!cur || it.cy - cur.cy > tol) lines.push({ cy: it.cy, items: [it] });
    else { cur.items.push(it); cur.cy = (cur.cy * (cur.items.length - 1) + it.cy) / cur.items.length; }
  }
  const out = [];
  for (const line of lines) {
    const groups = [];
    for (const w of line.items.sort((a, b) => a.x - b.x)) {
      const g = groups[groups.length - 1];
      const prev = g && g[g.length - 1];
      if (!g || w.x - (prev.x + prev.w) > 24) groups.push([w]);
      else g.push(w);
    }
    for (const g of groups) {
      const x0 = Math.min(...g.map((w) => w.x)), x1 = Math.max(...g.map((w) => w.x + w.w));
      const y0 = Math.min(...g.map((w) => w.y)), y1 = Math.max(...g.map((w) => w.y + w.h));
      out.push({ text: g.map((w) => w.text).join(''), x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 });
    }
  }
  return out;
}

// 抓一帧 + 跑一遍 OCR（只 1 倍：认"排行榜"三个字和数表格都够，省一半时间）
function probeScreen(dir, tag) {
  const shotDir = path.join(dir, 'nav');
  fs.mkdirSync(shotDir, { recursive: true });
  for (const f of fs.readdirSync(shotDir)) if (f.endsWith('.words.jsonl')) fs.unlinkSync(path.join(shotDir, f));
  ps('win-rank.ps1', ['-Action', 'shot', '-Title', TITLE, '-Out', path.join(shotDir, `${tag}.png`), '-Mode', MODE]);
  ps('win-ocr.ps1', ['-Dir', shotDir, '-Scale', '1', '-Tag', 's1']);
  const f = path.join(shotDir, `${tag}.s1.words.jsonl`);
  const words = fs.existsSync(f)
    ? fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.trim().startsWith('{')).map((l) => JSON.parse(l))
    : [];
  const { width, height } = sizeOf(shotDir, `${tag}.png`);
  return { words, width, height, file: path.join(shotDir, `${tag}.png`) };
}

const isLeaderboard = (words, width) => parseScreen(words, width).rows.length >= 3;

// 演武大会那一页（排行榜的上一层）。判据用标题/侧栏上那几个词 ——
// 认不出是哪一页就什么都不点，比瞎点安全。
const isHall = (labels) => labels.some((l) => /演武大会|英雄榜|积分赛/.test(l.text));

function clickAt(x, y) {
  // 先提一下窗口再点：点按是"点屏幕上的那个位置"，被别的窗口压着就点到别处去了
  ps('win-rank.ps1', ['-Action', 'activate', '-Title', TITLE]);
  sleep(200);
  ps('win-rank.ps1', ['-Action', 'click', '-Title', TITLE, '-X', String(Math.round(x)), '-Y', String(Math.round(y))]);
}

// 注入输入能不能到这个窗口：游戏是管理员权限跑的、而我们不是，Windows 会静默丢掉。
// 点按和滚轮是同一道墙，所以动手之前先问一句。
function inputBlocked() {
  const out = path.join(os.tmpdir(), `rank-info-${process.pid}.txt`);
  ps('win-rank.ps1', ['-Action', 'info', '-Title', TITLE, '-Out', out]);
  const text = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  try { fs.unlinkSync(out); } catch { /* 无所谓 */ }
  return /game=elevated/.test(text) && /self=normal/.test(text);
}

function navigate(dir) {
  if (inputBlocked()) {
    console.log('\n✗ 游戏是管理员权限跑的，这个进程不是：点击和滚轮都会被 Windows 丢掉。');
    console.log('  用管理员身份开的终端重跑，或者加 --watch 自己滚（那种模式不注入任何输入）。');
    process.exit(2);
  }

  let scr = probeScreen(dir, 'nav1');
  const onBoard = isLeaderboard(scr.words, scr.width);
  console.log(`  当前界面：${onBoard ? '排行榜' : '不是排行榜'}`);

  if (onBoard) {
    console.log('  点左上角箭头返回演武大会…');
    clickAt(BACK_AT[0] * scr.width, BACK_AT[1] * scr.height);
    sleep(1000);
    scr = probeScreen(dir, 'nav2');
    if (isLeaderboard(scr.words, scr.width)) {
      console.log('  ⚠ 点完箭头还在排行榜页（可能没点中），先停在这里，不往下点。');
      process.exit(2);
    }
  }

  const labels = labelsOf(scr.words);
  // 按钮文字可能被拆成"排/行/榜"几个词（还会把左边的图标认成"山"），
  // labelsOf 会把同一行挨着的词并回一条，所以这里按"含排行榜"找。
  const btn = labels
    .filter((l) => l.text.includes('排行榜') && l.cx < scr.width * 0.45 && l.cy > scr.height * 0.6)
    .sort((a, b) => b.cy - a.cy)[0];

  if (btn) {
    console.log(`  找到左下角按钮「${btn.text}」，点它重进排行榜…`);
    clickAt(btn.cx, btn.cy);
  } else if (isHall(labels)) {
    // 确认是演武大会页、只是这三个字没认出来 → 按量好的位置兜底
    console.log('  ⚠ 这一页是演武大会，但「排行榜」三个字没认出来，按量好的位置兜底点一下…');
    clickAt(HALL_BTN_AT[0] * scr.width, HALL_BTN_AT[1] * scr.height);
  } else {
    // 既不是排行榜也不是演武大会：不点。乱点会在游戏里点出别的东西来。
    console.log('\n✗ 认不出当前是哪个界面（既没有排行榜的表格，也没有演武大会的字）。');
    console.log('  什么都没有点。看一眼 ' + path.relative(process.cwd(), scr.file) + '，把游戏停在演武大会或排行榜页再跑。');
    process.exit(2);
  }

  sleep(1400);
  scr = probeScreen(dir, 'nav3');
  if (!isLeaderboard(scr.words, scr.width)) {
    console.log('\n✗ 点完还是没进到排行榜。看一眼 ' + path.relative(process.cwd(), scr.file) + ' 停在哪个界面。');
    process.exit(2);
  }
  console.log('  ✓ 已重进排行榜（数据是刚刷新过的），开始抓屏');
}

const sleep = (ms) => {
  // 同步睡：整条流程本来就是串行的，不值得为它引入 async 编排
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
};

// ── 主流程 ──
function run() {
  const dir = FROM ? path.resolve(FROM) : OUT;

  // 每 3 分钟一轮的定时任务靠这个控制磁盘占用（帧图比 rows.json 大两个数量级）
  pruneRuns(PRUNE_KEEP);

  // --score-reset 单独跑 = 把累加轮次清零，不出表也不发东西
  if (SCORE_RESET && !CAPTURE && !FROM) {
    nextScoreOffset();
    console.log(`偏移轮次已清零（下一轮从 +${SCORE_ADD || SCORE_GROW} 起）`);
    return Promise.resolve();
  }

  if (CAPTURE) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(WATCH
      ? `连拍：窗口「${TITLE}」，最多 ${FRAMES} 张 / ${WATCH_SECONDS} 秒。**现在开始自己滚榜单**，滚完等它自己收工。`
      : `抓屏：窗口「${TITLE}」 ${NO_SCROLL ? '只抓一屏' : `最多 ${FRAMES} 屏，每屏滚 ${NOTCHES} 格`}`);

    if (WATCH) {
      capture(dir, FRAMES);
    } else if (NO_SCROLL) {
      capture(dir, 1);
    } else if (NAVIGATE) {
      // 先回大厅、点「排行榜」重进一次（数据是进页面那一刻的），再开抓。
      console.log('先重进排行榜：');
      navigate(dir);
      captureAdaptive(dir);
    } else {
      // 不重进的时候，还是得确认停的是排行榜再开滚 ——
      // 之前有过一次游戏停在别的界面直接开滚，滚轮把用户自己的界面卷走了。
      if (!capture(dir, 1)) {
        probeDir(dir);
        const ok = readFrames(dir).some((f) => parseScreen(f.passes[0].words, sizeOf(dir, f.base + '.png').width).rows.length >= 3);
        if (!ok) {
          console.log('\n✗ 这一屏认不出排行榜（一行都没有）。先把游戏停在「州内积分赛排行榜」界面，再跑一次。');
          console.log('  已经抓到的图留在 ' + path.relative(process.cwd(), dir) + '，可以自己看一眼是不是停在别的界面。');
          process.exit(2);
        }
        console.log('  ✓ 第一屏确认是排行榜，开始滚');
        capture(dir, FRAMES);
      }
    }
  } else if (!FROM) {
    console.error('要么 --capture，要么 --from <已有帧目录>');
    process.exit(1);
  }

  const pngs = fs.readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
  if (!pngs.length) { console.error(`${dir} 里没有 frame-*.png`); process.exit(1); }

  // 相同的帧（滚到底之后每屏都一样）只留一张：省 OCR 时间，也不给合并添乱。
  const uniq = [];
  const seen = new Set();
  for (const f of pngs) {
    const h = sha1(fs.readFileSync(path.join(dir, f)));
    if (seen.has(h)) { fs.unlinkSync(path.join(dir, f)); continue; }
    seen.add(h);
    uniq.push(f);
  }
  if (uniq.length < pngs.length) console.log(`  丢掉 ${pngs.length - uniq.length} 张重复帧`);

  // 上一轮留下的词框会混进这一轮：先清掉
  console.log(`识别 ${uniq.length} 屏 × ${SCALES.length} 遍（Windows OCR）…`);
  probeDir(dir);

  const width = sizeOf(dir, uniq[0]).width;
  const frames = readFrames(dir);

  if (PROBE) {
    console.log('\n每个词框（核对列切分用）：');
    for (const f of frames) {
      for (const p of f.passes) {
        console.log(` ${f.base} ${p.tag}: ` + p.words.map((w) => `${w.text}@${Math.round(w.x)},${Math.round(w.y)}`).join('  '));
      }
    }
  }

  // 每屏的每一遍各自解析（见 parseScreen 上的注释：并集会把数字接坏），
  // 合并交给 merge 按名次投票。
  const screens = [];
  for (const f of frames) {
    for (const p of f.passes) {
      const sc = parseScreen(p.words, width);
      inferRanks(sc.rows);
      sc.label = `${f.base} ${p.tag}`;
      screens.push(sc);
    }
  }
  const blankScreens = screens.filter((s) => !s.rows.length);
  if (blankScreens.length) {
    console.log(`  ⚠ ${blankScreens.length} 屏一行都没认出来（多半不是排行榜界面）：` +
      blankScreens.slice(0, 4).map((s) => s.label).join('、'));
  }
  for (const s of screens) if (s.warns.length) console.log(`  ${s.label}: ${s.warns.length} 条提示`);
  if (argv.includes('--debug')) {
    console.log('\n每一遍各自解析出来的行：');
    for (const s of screens) {
      console.log(' ' + s.label);
      for (const r of s.rows) {
        console.log(`   y=${Math.round(r.y)} 名次=${r.rank}${r.inferred ? '(推)' : ''} 「${r.name}」 ${r.record} 杀=${r.kills} 分=${r.score}`);
      }
    }
  }

  const { rows, warns } = merge(screens);
  const allWarns = [...screens.flatMap((s) => s.warns.map((w) => `${s.label}: ${w}`)), ...warns];

  console.log('');
  printTable(rows);
  console.log(`\n${frames.length} 屏 × ${SCALES.length} 遍 → ${rows.length} 人（名次 1–${rows.length ? rows[rows.length - 1].rank : 0}）`);
  if (allWarns.length) {
    console.log('\n⚠ 要人看一眼的：');
    for (const w of allWarns) console.log('  · ' + w);
  }

  const out = path.join(dir, 'rows.json');
  fs.writeFileSync(out, JSON.stringify({
    capturedAt: new Date().toISOString(),
    title: TITLE,
    screens: screens.map((s) => s.label),
    rows: rows.map(({ observations, inferredRank, ...r }) => r),
    warnings: allWarns,
  }, null, 2));
  console.log(`\n表已写到 ${path.relative(process.cwd(), out)}（帧也在同一目录，留着核对）`);

  return deliver(rows, dir);
}

// ── 交给后端 ──
// 接口是**一行一个请求**：
//   POST <url>  Authorization: Bearer <token>  Content-Type: application/json
//   { "game_name": "[云]善丨路飞王", "score": 84 }
//
// 域名和令牌从 .env 的 SCORE_API_URL / SCORE_API_TOKEN 读（这台机器上已经配好），
// --post / --token 可以临时覆盖。
//
// 为什么逐行发而不是打包：接口就是这么定的（2026-10-18 用户给的服务端形状）。
// 好处是"谁没对上"能精确到人 —— 404 的那行就是站点上没有这个游戏名，
// 其余照写；坏处是一次抓取要发几十个请求，所以失败会被汇总成一张清单。
//
// 没认出积分的行不发 —— 少一个人，比给某人写个 0 分好。
function buildPayload(rows, offset = 0) {
  const good = rows.filter((r) => r.score !== null && r.name);
  const skipped = rows.length - good.length;
  if (skipped) console.log(`  （${skipped} 行没认出积分，不发）`);
  if (offset && good.length) {
    console.log(`  试跑偏移 +${offset}：实际 ${good[0].score} → 发出 ${good[0].score + offset}` +
      `（${good.length} 行都加，含下面那 70 个不在站点上的）`);
  }
  return good.map((r) => ({ game_name: r.name, score: r.score + offset }));
}

// ── 偏移记账 ──
// data/rank-shots/.offset-state.json 里只有三个字段：轮次、当前偏移、时间。
// 放这里而不是系统注册表/环境变量的原因：这个整目录已经在 .gitignore 里，
// 删掉就等于清零，也不污染机器上任何别的东西。
function readOffsetState() {
  try { return JSON.parse(fs.readFileSync(OFFSET_STATE, 'utf8')); } catch { return { rounds: 0, offset: 0 }; }
}
function writeOffsetState(s) {
  fs.mkdirSync(path.dirname(OFFSET_STATE), { recursive: true });
  fs.writeFileSync(OFFSET_STATE, JSON.stringify(s, null, 2));
}
// 这一轮该加多少。**只在真要发的时候调**（见 deliver）：光解析不发、
// 反复重放同一批帧验证切列，不该把轮次烧掉。
function nextScoreOffset() {
  if (SCORE_RESET) {
    writeOffsetState({ rounds: 0, offset: SCORE_ADD, updatedAt: new Date().toISOString() });
    console.log('  偏移轮次已清零');
    return SCORE_ADD;
  }
  if (!SCORE_GROW) return SCORE_ADD;
  const rounds = (readOffsetState().rounds || 0) + 1;
  const offset = SCORE_ADD + SCORE_GROW * rounds;
  writeOffsetState({ rounds, offset, updatedAt: new Date().toISOString() });
  console.log(`  第 ${rounds} 轮试跑：积分 +${offset}`);
  return offset;
}

// 这一轮**如果发**会加多少，但不推进轮次 —— 给 --payload 用：
// 写出来的报文要和真发的一模一样，可光写报文不该烧掉一轮。
function peekScoreOffset() {
  if (!SCORE_GROW) return SCORE_ADD;
  return SCORE_ADD + SCORE_GROW * ((readOffsetState().rounds || 0) + 1);
}

// ── 清旧目录 ──
// 两条都验过才敢删：名字必须是默认的 <时间戳> 形式（trial/live1/selftest 这些
// 夹具目录不匹配），并且必须真在 data/rank-shots 下一层。
function bytesUnder(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    n += e.isDirectory() ? bytesUnder(p) : fs.statSync(p).size;
  }
  return n;
}
function pruneRuns(keep) {
  if (!keep) return;
  // 目录名是 OUT 默认的 toISOString 形式：20261017-072236（UTC，没有分隔符）。
  const STAMP_RE = /^\d{8}-\d{6}$/;
  const root = path.resolve(SHOTS_ROOT);
  let names;
  try { names = fs.readdirSync(root); } catch { return; }
  const dirs = names.filter((n) => STAMP_RE.test(n) && fs.statSync(path.join(root, n)).isDirectory()).sort();
  const drop = dirs.slice(0, Math.max(0, dirs.length - keep));
  let freed = 0;
  let n = 0;
  for (const d of drop) {
    const abs = path.resolve(root, d);
    if (path.dirname(abs) !== root || !STAMP_RE.test(path.basename(abs))) continue;
    try {
      freed += bytesUnder(abs);
      fs.rmSync(abs, { recursive: true, force: true });
      n++;
    } catch (e) {
      console.log(`  清 ${d} 失败（不影响这一轮）：${e.message}`);
    }
  }
  if (n) console.log(`  清掉 ${n} 个旧抓取目录（留最近 ${keep} 轮），腾出 ${(freed / 1048576).toFixed(1)}MB`);
}

// 一个名字可能有好几种写法，按顺序试，第一个对上就停：
//   ① 榜上原样          [云]善丨路飞王
//   ② 去掉 [阵营] 前缀  善丨路飞王        ← 实测玩家就是这么填的（2026-10-18 路飞王）
//   ③ 前缀去掉 + 竖线统一成 丨（U+4E28）  善丨路飞王
//   ④ 前缀去掉 + 竖线统一成 |            善|路飞王
// 只为了对付"玩家填的写法"和"OCR 认出来的写法"不一致，**不去猜错字**——
// 「剿」和「秦」那种错字这里救不了，那种只能靠后端模糊匹配。
function nameVariants(name) {
  const out = [name];
  const stripped = name.replace(/^\[[^\]]*\]/, '');
  if (stripped !== name) out.push(stripped);
  const base = stripped;
  for (const sep of ['丨', '|']) {
    const v = base.replace(/[|｜丨︱]/g, sep);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

// ── 批量发送 ──
// 接口收的是**裸数组**，不是 {"rows": …}：
//   POST <url>   Authorization: Bearer <token>   Content-Type: application/json
//   [ {"game_name":"善丨路飞王","score":84}, {"game_name":"善丨大葱王","score":59} ]
// 回执里的 results[] 与请求**等长同序**，所以按下标就能把每条对回原来那一行；
// 每条也带 game_name，对不上顺序时还能按名字找（见下面那个兜底）。
// 这两点都是 2026-10-18 拿真实接口问出来的：rows/scores/items/data/list 这些
// 包装一律被当成"game_name 不能为空"，只有裸数组认。
async function postBatch(entries) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), POST_TIMEOUT_MS);
  try {
    const r = await fetch(POST, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
      },
      body: JSON.stringify(entries),
      signal: ctl.signal,
    });
    const text = (await r.text()).trim();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON 就当它没给结论 */ }
    return { http: r.status, ok: r.ok, text, json };
  } catch (e) {
    return { http: 0, ok: false, text: e.name === 'AbortError' ? `${POST_TIMEOUT_MS}ms 超时` : e.message, json: null };
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(rows, dir) {
  if (!POST && !PAYLOAD) return;
  // 偏移只在**真发**时推进轮次：--payload 只写报文给人看，不该烧掉一轮。
  const offset = POST ? nextScoreOffset() : peekScoreOffset();
  const items = buildPayload(rows, offset);

  if (PAYLOAD) {
    const p = path.resolve(PAYLOAD);
    fs.writeFileSync(p, JSON.stringify(items, null, 2));
    console.log(`报文已写到 ${path.relative(process.cwd(), p)}（${items.length} 行）`);
  }
  if (!POST) return;

  // 一条 OCR 行展开成几种写法，全部塞进同一个包：多出来的只是一点体积，
  // 比"发一个 → 等回话 → 再发下一个"便宜两个数量级。实测 301 条一包照样 200。
  const entries = [];
  const owner = [];                     // entries[i] 属于 items 的第几行
  items.forEach((it, idx) => {
    for (const v of nameVariants(it.game_name)) {
      entries.push({ game_name: v, score: it.score });
      owner.push(idx);
    }
  });

  const CHUNK = BATCH_SIZE > 0 ? BATCH_SIZE : (entries.length || 1);
  const results = new Array(entries.length).fill(null);   // 按下标对回 entries
  const requests = [];
  let aborted = '';
  console.log(`\n发送 ${items.length} 行（展开成 ${entries.length} 条写法）→ ${POST}` +
    (CHUNK < entries.length ? `，分 ${Math.ceil(entries.length / CHUNK)} 个包` : '，一个包'));

  for (let start = 0; start < entries.length && !aborted; start += CHUNK) {
    const slice = entries.slice(start, start + CHUNK);
    const res = await postBatch(slice);
    requests.push({ http: res.http, entries: slice.length });

    // 令牌错 / 没权限 / 没有进行中的赛期：整批停，别再打下去
    if (res.http === 401 || res.http === 403 || res.http === 409) {
      const why = (res.json && (res.json.results?.[0]?.error || res.json.error)) || res.text.slice(0, 80);
      aborted = `HTTP ${res.http}：${why}`;
      break;
    }
    const out = res.json && Array.isArray(res.json.results) ? res.json.results : null;
    for (let i = 0; i < slice.length; i++) {
      let row = null;
      if (out) {
        // 合同是等长同序；万一哪天变成"只回认下来的那些"，就退回按名字找
        if (out.length === slice.length) row = out[i] || null;
        else row = out.find((x) => x && x.game_name === slice[i].game_name) || null;
      }
      results[start + i] = { http: res.http, row, text: res.text };
    }
    if (start + CHUNK < entries.length) await new Promise((r2) => setTimeout(r2, 120));
  }

  // 一条 OCR 行算不算成功：它展开的写法里**任意一条**被认下来就算，全都 unknown
  // 才算"不在站点上"。前缀、竖线这些写法差异就这么一次消化掉，不用逐行重试。
  const best = new Map();               // idx -> {name_used, changed}
  const unknown = new Map();            // idx -> 服务端的原话
  const failure = new Map();            // idx -> {status, text}
  entries.forEach((e, i) => {
    const idx = owner[i];
    const r = results[i];
    if (!r) return;
    const row = r.row;
    if (row && row.status && row.status !== 'unknown') {
      if (!best.has(idx)) best.set(idx, { name_used: e.game_name, changed: row.changed !== false });
    } else if (row && row.status === 'unknown') {
      if (!unknown.has(idx)) unknown.set(idx, row.error || '没有这个游戏名对应的用户');
    } else if (!failure.has(idx)) {
      failure.set(idx, { status: r.http || 0, text: r.text || '没有响应' });
    }
  });

  const ok = [];
  const bad = [];
  let fallbackUsed = 0;
  items.forEach((it, idx) => {
    const hit = best.get(idx);
    if (hit) {
      ok.push({ ...it, name_used: hit.name_used, changed: hit.changed });
      if (hit.name_used !== it.game_name) fallbackUsed++;
      return;
    }
    if (unknown.has(idx)) { bad.push({ ...it, status: 'unknown', text: unknown.get(idx) }); return; }
    const f = failure.get(idx) || { status: 0, text: aborted || '没有响应' };
    bad.push({ ...it, status: f.status, text: f.text });
  });

  const unchanged = ok.filter((o) => !o.changed).length;
  console.log(`✓ 写入 ${ok.length - unchanged} 行${unchanged ? `，另有 ${unchanged} 行分数没变` : ''}` +
    (fallbackUsed ? `（其中 ${fallbackUsed} 行是靠换了写法才对上的）` : '') +
    `　[${requests.length} 个请求 / ${entries.length} 条写法]`);

  // 名字对不上**不算失败**：榜单是整个赛区的，站点上只有自己这群人，
  // 那些陌生玩家本来就不该写进来（2026-10-18 用户口径："无需处理失败的人，
  // 有很多玩家不在我的用户名单里"）。真正算失败的只有网络/鉴权/赛期那几种。
  const stranger = bad.filter((b) => b.status === 'unknown');
  const broken = bad.filter((b) => b.status !== 'unknown');
  if (stranger.length) {
    console.log(`  ${stranger.length} 个名字不在站点上（跳过，正常 —— 榜单是整个赛区的）`);
  }
  if (broken.length) {
    console.log(`✗ ${broken.length} 行是真的失败了：`);
    for (const b of broken.slice(0, 10)) {
      const why = !b.text ? '' : (b.text.startsWith('<') ? '（返回的是 HTML 错误页，不是 JSON）' : b.text.slice(0, 80));
      console.log(`   ${b.game_name}（${b.score}）→ ${b.status || '网络'} ${why}`);
    }
    process.exitCode = 3;
  }
  if (aborted) console.error(`✗ 提前停手：${aborted}`);

  // 落一份回执：定时任务跑的时候没人盯着控制台，这份文件才是事后能查的东西。
  const report = {
    at: new Date().toISOString(),
    endpoint: POST,
    scoreOffset: offset,
    round: SCORE_GROW ? (readOffsetState().rounds || 0) : 0,
    sent: items.length,
    entries: entries.length,
    requests,
    written: ok.length - unchanged,
    unchanged,
    notOnSite: stranger.map((b) => ({ game_name: b.game_name, score: b.score })),
    failed: broken.map((b) => ({ game_name: b.game_name, score: b.score, status: b.status, error: b.text })),
    matchedViaPrefixStrip: fallbackUsed,
    aborted,
  };
  const reportPath = path.join(dir, 'send-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`回执：${path.relative(process.cwd(), reportPath)}`);
}
if (require.main === module) {
  run().catch((e) => {
    console.error(e.message || e);
    process.exitCode = 1;
  });
} else {
  // 给测试用：切行列、切标签、合并投票这几块都是纯函数，可以脱离窗口和 OCR 单独验
  // （和 recognize-ocr.js 导出 _splitK/_sim 一个路数）。
  module.exports = { parseScreen, merge, inferRanks, labelsOf, probeScreen, sizeOf, isLeaderboard, buildPayload, BACK_AT, HALL_BTN_AT };
}
