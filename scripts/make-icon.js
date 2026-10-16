/* ==========================================================================
   站点图标生成器（一次性工具，不是构建步骤）

     node scripts/make-icon.js          # 写 public/icon.svg + favicon.ico + apple-touch-icon.png

   产出三份，都是**提交进仓库**的静态文件，页面只引用它们，运行时不做任何生成：
     public/icon.svg            矢量的那份（现代浏览器优先用它，任意倍率都清）
     public/favicon.ico         16/32/48 三档打进一个 ICO（老浏览器、以及 /favicon.ico 的裸探测）
     public/apple-touch-icon.png 180×180，iOS 加桌面用（**满幅不圆角**，圆角是系统自己切的）

   设计：一方**金印**——金色渐变做底、墨色的「武」压在正中，和 .topnav .brand::before
   那根金色短竖是同一套颜色（--yw-gold-lt → --yw-gold-dk，见 public/style.css）。
   底色选了金而不是墨，是因为页签栏有亮有暗，深墨方章在深色页签栏上整个糊掉。

   ★ **「武」是取轮廓变成 path 的，不是 <text>**：
     SVG 里的 <text> 要靠**看的人那台机器**上有中文字体才画得出来，缺字体就是一格豆腐。
     图标这种"必须有"的东西不能赌，所以这里自己读 TTF 的 glyf 表把轮廓抠出来。
     字形来自 Droid Sans Fallback（Debian 的 fonts-droid-fallback，Apache-2.0），
     和本站同一个许可证，抠出来的轮廓可以随仓库一起公开。
     换字只需改下面的 CHAR，换字体用 ICON_FONT 指过去（那个字得是**简单轮廓**，
     复合字形会当场报错，不会闷声画错）。
   ========================================================================== */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public');
const FONT = process.env.ICON_FONT
  || '/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf';
const CHAR = '武';

// 配色（public/style.css 的令牌）
const INK = '#14110c';          // --yw-ink-900：字的颜色
const GOLD_LT = '#e8cd86';      // --yw-gold-lt：渐变顶
const GOLD_DK = '#a07c2c';      // 渐变底（比 --yw-gold-dk #8a6d2c 稍微提亮一点，
                                // 不然 16px 那档整块发闷）
const FILL = 0.66;              // 字占方块的边长比（按字形实际外框算，不是按字身框）
const RX = 14;                  // 圆角，单位是 viewBox 的 100 分之一
const BOLD = 0.055;             // 描边加粗量（这个字体没有粗体，靠同色描边假粗）

/* ---------------- 极简 TrueType：取一个字的轮廓 ---------------- */
// 只认 glyf（TrueType 轮廓）。CFF/OTF 那套是另一回事，本机用不上，遇到就直说。

const readFont = (file) => {
  const d = fs.readFileSync(file);
  const n = d.readUInt16BE(4);
  const tabs = {};
  for (let i = 0; i < n; i++) {
    const o = 12 + i * 16;
    tabs[d.toString('latin1', o, o + 4)] = { off: d.readUInt32BE(o + 8), len: d.readUInt32BE(o + 12) };
  }
  for (const need of ['head', 'loca', 'glyf', 'cmap']) {
    if (!tabs[need]) throw new Error(`字体里没有 ${need} 表（是不是 CFF/OTF？这个脚本只认 TrueType）`);
  }
  return {
    d,
    unitsPerEm: d.readUInt16BE(tabs.head.off + 18),
    longLoca: d.readInt16BE(tabs.head.off + 50) === 1,
    loca: tabs.loca.off,
    glyf: tabs.glyf.off,
    cmap: tabs.cmap.off,
  };
};

// cmap 查码点 → 字形号。优先 format 12（能盖住 BMP 以外），退回 format 4。
const glyphId = (f, cp) => {
  const { d } = f;
  const nt = d.readUInt16BE(f.cmap + 2);
  const subs = [];
  for (let i = 0; i < nt; i++) {
    const pid = d.readUInt16BE(f.cmap + 4 + i * 8);
    const off = f.cmap + d.readUInt32BE(f.cmap + 8 + i * 8);
    subs.push({ pid, fmt: d.readUInt16BE(off), off });
  }
  const pick = [12, 4].map((fmt) => subs.find((s) => s.fmt === fmt)).filter(Boolean);
  if (!pick.length) throw new Error('cmap 里没有能用的 format 4 / 12 子表');

  for (const s of pick) {
    if (s.fmt === 12) {
      const groups = d.readUInt32BE(s.off + 12);
      for (let i = 0; i < groups; i++) {
        const o = s.off + 16 + i * 12;
        const [a, b, g] = [d.readUInt32BE(o), d.readUInt32BE(o + 4), d.readUInt32BE(o + 8)];
        if (cp >= a && cp <= b) return g + (cp - a);
      }
    } else {
      const segX2 = d.readUInt16BE(s.off + 6);
      const seg = segX2 / 2;
      const ends = s.off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let i = 0; i < seg; i++) {
        const end = d.readUInt16BE(ends + i * 2);
        const start = d.readUInt16BE(starts + i * 2);
        if (cp < start || cp > end) continue;
        const ro = d.readUInt16BE(ranges + i * 2);
        const delta = d.readInt16BE(deltas + i * 2);
        if (ro === 0) return (cp + delta) & 0xffff;
        const g = d.readUInt16BE(ranges + i * 2 + ro + (cp - start) * 2);
        return g ? (g + delta) & 0xffff : 0;
      }
    }
  }
  return 0;
};

// 字形 → 若干条轮廓，每条是一串 {x, y, on}（字体坐标系，y 朝上）
const glyphContours = (f, gid) => {
  const { d } = f;
  const at = (i) => (f.longLoca ? d.readUInt32BE(f.loca + i * 4) : d.readUInt16BE(f.loca + i * 2) * 2);
  const start = f.glyf + at(gid);
  const nc = d.readInt16BE(start);
  if (nc < 0) throw new Error('这个字是复合字形（拼别的字形拼出来的），本脚本不拆它');
  if (nc === 0) throw new Error('这个字在字体里是空的');

  const ends = [];
  for (let i = 0; i < nc; i++) ends.push(d.readUInt16BE(start + 10 + i * 2));
  let p = start + 10 + nc * 2;
  p += 2 + d.readUInt16BE(p);                       // 跳过 hinting 指令

  const total = ends[nc - 1] + 1;
  const flags = [];
  while (flags.length < total) {
    const fl = d.readUInt8(p++);
    flags.push(fl);
    if (fl & 8) { const rep = d.readUInt8(p++); for (let i = 0; i < rep; i++) flags.push(fl); }
  }
  const xs = [];
  let x = 0;
  for (const fl of flags) {
    if (fl & 2) { const v = d.readUInt8(p++); x += (fl & 16) ? v : -v; } else if (!(fl & 16)) x += d.readInt16BE((p += 2) - 2);
    xs.push(x);
  }
  const ys = [];
  let y = 0;
  for (const fl of flags) {
    if (fl & 4) { const v = d.readUInt8(p++); y += (fl & 32) ? v : -v; } else if (!(fl & 32)) y += d.readInt16BE((p += 2) - 2);
    ys.push(y);
  }

  const out = [];
  let from = 0;
  for (const end of ends) {
    const c = [];
    for (let i = from; i <= end; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) });
    out.push(c);
    from = end + 1;
  }
  return out;
};

/* ---------------- 轮廓 → SVG path ---------------- */
// TrueType 是二次贝塞尔：连续两个控制点之间要取中点当落点。整条轮廓一个 on 点都没有时，
// 第一条边得从中点起步 —— 这两条不写，圆点（比如「口」的角）会缺一块。
const contourPath = (pts, map) => {
  const n = pts.length;
  const P = (i) => map(pts[(i + n) % n]);
  let first = pts.findIndex((q) => q.on);
  const seg = [];
  if (first < 0) { first = 0; seg.push(['M', mid(pts[0], pts[1])]); }
  else seg.push(['M', P(first)]);

  for (let k = 1; k <= n; k++) {
    const cur = pts[(first + k) % n];
    const nxt = pts[(first + k + 1) % n];
    if (cur.on) { seg.push(['L', P((first + k))]); continue; }
    if (nxt.on) { seg.push(['Q', P((first + k)), P((first + k + 1))]); k++; continue; }
    seg.push(['Q', P((first + k)), mid(cur, nxt)]);   // 两个控制点挨着：落点取中点
  }
  return [...seg, ['Z']];
};
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });

const buildPath = (contours, fill) => {
  const pts = contours.flat();
  const x0 = Math.min(...pts.map((q) => q.x));
  const x1 = Math.max(...pts.map((q) => q.x));
  const y0 = Math.min(...pts.map((q) => q.y));
  const y1 = Math.max(...pts.map((q) => q.y));
  // 外框等比放进正中的 fill×100 方块里；y 翻过来（字体 y 朝上，SVG 朝下）
  const k = (fill * 100) / Math.max(x1 - x0, y1 - y0);
  const tx = 50 - (k * (x1 - x0)) / 2 - k * x0;
  const ty = 50 + (k * (y1 - y0)) / 2 + k * y0;
  const map = (q) => ({ x: tx + k * q.x, y: ty - k * q.y });
  const r = (v) => Math.round(v * 100) / 100;

  return contours
    .map((c) => contourPath(c, map)
      .map(([cmd, a, b]) => (cmd === 'Z' ? 'Z'
        : cmd === 'Q' ? `Q${r(a.x)} ${r(a.y)} ${r(b.x)} ${r(b.y)}`
          : `${cmd}${r(a.x)} ${r(a.y)}`))
      .join(''))
    .join('');
};

/* ---------------- 拼出图标 ---------------- */
const iconSvg = (d, size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${GOLD_LT}"/>
      <stop offset="1" stop-color="${GOLD_DK}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" rx="${RX}" ry="${RX}" fill="url(#g)"/>
  <path d="${d}" fill="${INK}" stroke="${INK}" stroke-width="${BOLD}" stroke-linejoin="round"/>
</svg>
`;

// 满幅那版：iOS 自己切圆角，底色必须铺满整块，否则四角会被切成黑的
const touchSvg = (d) => `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${GOLD_LT}"/>
      <stop offset="1" stop-color="${GOLD_DK}"/>
    </linearGradient>
  </defs>
  <rect width="100" height="100" fill="url(#g)"/>
  <path d="${d}" fill="${INK}" stroke="${INK}" stroke-width="${BOLD}" stroke-linejoin="round"/>
</svg>
`;

// ICO 容器：header(6) + 每张 16 字节目录 + 各自的 PNG 字节。
// 里面装的是 PNG 而不是老式 BMP——Vista 起都认，够用。
const buildIco = (imgs) => {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);                 // 1 = 图标
  head.writeUInt16LE(imgs.length, 4);
  let off = 6 + 16 * imgs.length;
  const dir = imgs.map(({ size, buf }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);   // 0 表示 256
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt16LE(1, 4);                     // 色平面
    e.writeUInt16LE(32, 6);                    // 位深
    e.writeUInt32LE(buf.length, 8);
    e.writeUInt32LE(off, 12);
    off += buf.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...imgs.map((i) => i.buf)]);
};

(async () => {
  const f = readFont(FONT);
  const gid = glyphId(f, CHAR.codePointAt(0));
  if (!gid) throw new Error(`字体里没有「${CHAR}」`);
  const d = buildPath(glyphContours(f, gid), FILL);

  fs.writeFileSync(path.join(OUT, 'icon.svg'), iconSvg(d, 128));
  const png = (svg, size) => sharp(Buffer.from(svg)).resize(size, size).png({ compressionLevel: 9 }).toBuffer();

  const ico = [];
  for (const size of [16, 32, 48]) ico.push({ size, buf: await png(iconSvg(d, size), size) });
  fs.writeFileSync(path.join(OUT, 'favicon.ico'), buildIco(ico));
  fs.writeFileSync(path.join(OUT, 'apple-touch-icon.png'), await png(touchSvg(d), 180));

  console.log(`✓ 字形来自 ${path.basename(FONT)}（字形号 ${gid}，字身 ${f.unitsPerEm}）`);
  for (const p of ['icon.svg', 'favicon.ico', 'apple-touch-icon.png']) {
    console.log(`  public/${p}  ${(fs.statSync(path.join(OUT, p)).size / 1024).toFixed(1)}KB`);
  }
})();
