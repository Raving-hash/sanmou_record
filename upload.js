const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const DIR = path.join(__dirname, 'uploads');
const STAGE = path.join(DIR, '.incoming');   // 原始上传先落这里，压完立刻删
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

const MAX_INPUT = 10 * 1024 * 1024;   // 玩家单张原图的体积上限
const MAX_OUT = 1024 * 1024;          // ★ 压缩后的硬上限：1MB

// ---------- 缩略图 ----------
// 页面上显示这些图的地方其实都很小：阵容卡 200×160（手机 150×120）、表格里的
// .thumb 200×160、最大的 .thumb-lg 也就 320 宽。从前一律喂原图（350~390KB 一张），
// 而隧道单程 1.1s —— 实测首页二十张图 5.19MB 要 35s，一屏小格子把整条带宽吃光了。
//
// 命名：原文件名后面**直接接**后缀 —— <uuid>.jpg → <uuid>.jpg.thumb.jpg。
// 为什么不加在中缀（<uuid>.thumb.jpg）：那样反推不回原图（.jpg 还是 .png？），
// 而 /uploads 的游客白名单正是靠"把后缀切掉再查库"来决定放不放行的（见 app.js）。
// 为什么不另开一个 uploads/t/ 子目录：这样一来 uploads/ 仍然是**平铺一层**，
// 删图时顺手删掉旁边那个 .thumb.jpg 就行，不用管目录、也不用清空目录。
//
// 640 / q72 是照着真图挑的：350~390KB → 23~30KB（约 13 倍），
// 而最大那个显示位（.thumb-lg 320px）在 2 倍屏上也只需要 640。要调就改这两行。
const THUMB_SUFFIX = '.thumb.jpg';
const THUMB_EDGE = 640;
const THUMB_Q = 72;

// STAGE 必须以字符串形式传给 multer，所以得先建出来。
// 目录名以点开头，express.static 默认 dotfiles:'ignore'，不会被 /uploads 暴露。
fs.mkdirSync(STAGE, { recursive: true });

// multer 只负责把原始文件收下来落到 STAGE。真正入库的是压缩后的那份，
// 文件名在 compressUploads 里换成 <uuid>.jpg（见下）。
const upload = multer({
  storage: multer.diskStorage({
    destination: STAGE,
    filename: (req, file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: MAX_INPUT },
  fileFilter: (req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new Error('只支持 jpg / png / webp 图片')),
});

// 压缩阶梯：[长边上限, jpeg 画质]，从上往下试，第一个压进 1MB 的就用。
//
// 第一档特意不缩尺寸（4096 配上 withoutEnlargement 等于原样），
// 因为只重编码往往就够了 —— 实测 2844×1280 的游戏截图，原尺寸 q84 只有约 300KB，
// 没必要为了体积去动人家的像素。真正压不动的图（大面积噪点的照片）才逐档降尺寸。
// 末尾几档是兜底：1000 万像素的纯噪声图要降到长边 1600 才能进 1MB。
const LADDER = [
  [4096, 84], [4096, 76],
  [3200, 80], [3200, 72],
  [2560, 78], [2560, 70],
  [1920, 76], [1920, 66],
  [1600, 72], [1600, 62],
  [1280, 70],
  [1024, 66],
];

// 压一张，写成 DIR/<outName>，返回压缩后的字节数
async function compressOne(srcPath, outName) {
  //    rotate() 无参 = 按 EXIF 方向摆正，手机竖拍的照片不会再躺着
  //    failOn:'none' = 尾部截断的图也照压，不整个失败
  //    limitInputPixels = 防解压炸弹（1 亿像素）
  const base = sharp(srcPath, { failOn: 'none', limitInputPixels: 1e8 }).rotate();

  for (const [edge, quality] of LADDER) {
    let buf;
    try {
      buf = await base.clone()
        .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })   // png 的透明区落成白底，jpeg 不支持透明，不然会变黑
        .jpeg({ quality, chromaSubsampling: '4:2:0' })
        .toBuffer();
    } catch {
      // 走到这里说明 sharp 根本解不开这个文件：改了后缀的文本、损坏的图、等等
      throw new Error('这个文件不是能识别的图片，或者已经损坏了');
    }
    if (buf.length <= MAX_OUT) {
      await fsp.writeFile(path.join(DIR, outName), buf);
      return buf.length;
    }
  }
  throw new Error('这张图压不到 1MB 以下，换一张试试');
}

// 生成（或确认已经存在）某张图的缩略图，返回缩略图的文件名。**幂等**：已经有了就直接返回。
// name 是 uploads/ 里的文件名（<uuid>.jpg）。原图不在就让它抛 ENOENT，由调用方决定怎么办。
// 原图是 compressOne 刚写出来的、已经摆正过的 jpg，所以这里不用再 rotate。
async function makeThumb(name) {
  const base = path.basename(name);
  const out = base + THUMB_SUFFIX;
  if (fs.existsSync(path.join(DIR, out))) return out;

  const buf = await sharp(path.join(DIR, base), { failOn: 'none' })
    .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: THUMB_Q, chromaSubsampling: '4:2:0' })
    .toBuffer();

  // 先落 STAGE（以点开头的目录，express.static 不发它）再 rename 过去：
  // rename 是原子的，并发的第二个请求不会读到半张图；中途失败也不会在 uploads/ 里留垃圾。
  const tmp = path.join(STAGE, crypto.randomUUID());
  await fsp.writeFile(tmp, buf);
  try {
    await fsp.rename(tmp, path.join(DIR, out));
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
  return out;
}

// 挂在 multer 之后。把 STAGE 里的原始文件逐个压成 <1MB 的 jpg，
// 并把 file.filename 换成压缩后的名字 —— 路由层拿到的就是最终文件名，一行都不用改。
async function compressUploads(req, res, next) {
  const files = req.files || (req.file ? [req.file] : []);
  const staged = files.map((f) => f.path);

  try {
    for (const f of files) {
      const out = crypto.randomUUID() + '.jpg';
      f.size = await compressOne(f.path, out);
      f.filename = out;
      f.mimetype = 'image/jpeg';
      // 缩略图跟着原图一起做出来：页面第一次引用它时就是现成的，不用在请求路径上现压。
      // **做不出来不算上传失败**（原图都已经压好了，几乎不可能）—— app.js 的 /uploads
      // 那边有兜底，会在第一次被要到时补一张，用户顶多第一次点开慢一点。
      await makeThumb(out).catch((e) => console.error('生成缩略图失败（不影响上传）：', out, e.message));
    }
    next();
  } catch (err) {
    // 中途失败：已经压好的那几张也不能留在库里（它们还没进数据库）。
    // 走 removeFile 而不是直接 rm —— 它会把缩略图一起带走；漏了的话这里会留下
    // 没人引用的 <uuid>.jpg.thumb.jpg（那几张的缩略图可能已经做好了）。
    // 还没轮到的 f.filename 是 STAGE 里的临时名，removeFile 找不到就算了（下面 finally 收尾）。
    for (const f of files) removeFile(f.filename);
    next(err);
  } finally {
    await Promise.all(staged.map((p) => fsp.rm(p, { force: true })));
  }
}

// 删除文件；文件不存在也不报错。**缩略图跟着原图一起删** —— 它就在同一个目录里，
// 漏删的话 uploads/ 会慢慢积一堆没人引用的 <uuid>.jpg.thumb.jpg。
// 全站的删图都走这里（删单张阵容图、换积分截图、删赛期、上传失败回滚），所以只有这一处要管。
// 改成同步 unlink：这些路径要的就是"回完响应它一定已经没了"，而且删的本就是本地小文件（微秒级）。
function removeFile(name) {
  if (!name) return;
  const base = path.basename(name);
  const list = base.endsWith(THUMB_SUFFIX) ? [base] : [base, base + THUMB_SUFFIX];
  for (const n of list) {
    try { fs.unlinkSync(path.join(DIR, n)); } catch { /* 本来就不在 */ }
  }
}

// 批量删除（删除赛期 / 上传失败回滚时用）
function removeFiles(names) {
  for (const n of names || []) removeFile(n);
}

module.exports = {
  upload, compressUploads, removeFile, removeFiles, compressOne,
  makeThumb, THUMB_SUFFIX,
  UPLOAD_DIR: DIR, ALLOWED_EXT: EXT,
  MAX_INPUT_BYTES: MAX_INPUT, MAX_OUT_BYTES: MAX_OUT,
};
// compressOne 导出给 scripts/recompress.js 用：老图的补压必须走同一套阶梯，
// 抄一份到脚本里迟早会和这里改岔。
