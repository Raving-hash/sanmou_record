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
    }
    next();
  } catch (err) {
    // 中途失败：已经压好的那几张也不能留在库里（它们还没进数据库）
    await Promise.all(files.map((f) => fsp.rm(path.join(DIR, f.filename), { force: true })));
    next(err);
  } finally {
    await Promise.all(staged.map((p) => fsp.rm(p, { force: true })));
  }
}

// 删除文件；文件不存在也不报错
function removeFile(name) {
  if (name) fs.unlink(path.join(DIR, path.basename(name)), () => {});
}

// 批量删除（删除赛期 / 上传失败回滚时用）
function removeFiles(names) {
  for (const n of names || []) removeFile(n);
}

module.exports = {
  upload, compressUploads, removeFile, removeFiles, compressOne,
  UPLOAD_DIR: DIR, ALLOWED_EXT: EXT,
  MAX_INPUT_BYTES: MAX_INPUT, MAX_OUT_BYTES: MAX_OUT,
};
// compressOne 导出给 scripts/recompress.js 用：老图的补压必须走同一套阶梯，
// 抄一份到脚本里迟早会和这里改岔。
