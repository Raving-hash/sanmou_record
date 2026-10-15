const crypto = require('crypto');
const https = require('https');
const http = require('http');
const dns = require('dns');
const { URL } = require('url');

/* ==========================================================================
   Cloudflare R2 客户端 —— 只做本站点用到的六件事：

     ① 签**上传用的 presigned PUT**：浏览器拿着它直传 R2，图片字节一个都不经过
        这台机器（这是本次改造的全部意义 —— 隧道单程 1.1s，字节别再走它了）。
     ② HEAD 一个对象：写库**之前**核对"真的传上去了、体积没超、类型是 jpeg"。
     ③ 批量删对象：删阵容图 / 换积分截图 / 撤回积分 / 删整个赛期。
     ④ 服务端直传（迁移脚本用）。
     ⑤ 下载对象（备份 / 回滚时把对象拉回本地）。
     ⑥ 列全量（备份 / GC / 迁移核对）。

   ---- 为什么手写 SigV4，不用 @aws-sdk/client-s3 ----
   两件事凑到一起：

   (a) **发布流水线明确拦依赖变更**。`sanmouyanwu-dev/.devlocal/release.sh:92-95`：
       「package.json / package-lock.json 变了 —— 线上 node_modules 不会跟着变」，
       直接拒绝发布。加两个包就得走"开发目录装好 → cp -a node_modules 同步到线上"
       那条手工路，而这个仓库的既有取舍是**能不加依赖就不加**（上一版七牛客户端
       就是为此手写 HMAC-SHA1 的，理由写在它自己的文件头里）。

   (b) **手写反而少两个坑，不是多**。用 SDK 的话：
       · v3 的 presigner 默认只签 `content-length;host`，必须显式传 signableHeaders
         才盖得住 content-type / cache-control（不盖住就有安全与缓存两个后果，见下）；
       · v3 ≥3.729 默认发 `x-amz-checksum-crc32`，R2 不认，报 NotImplemented。
       这两条都是 **SDK 的行为**，自己发请求就不存在。

   ---- 环境变量（全在 .env 里）----
     R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   S3 API 令牌
     R2_BUCKET                     桶名
     R2_ENDPOINT                   默认 https://<account>.r2.cloudflarestorage.com
     R2_PUBLIC_BASE_URL            图片访问域名，如 https://img.example.com
                                   ★ 页面里就写它。这个桶是**公开**的（无签名）。

   ★ R2_ENDPOINT 特意支持 `http://`：测试沙箱里可以拿一个本地桩顶替真 R2
     （写进 R2_ENDPOINT=http://127.0.0.1:3993），这样十套服务端断言和七套浏览器
     断言**不必联网、不必真凭证**就能整套跑通。上一版七牛客户端就是这么设计的
     （见已删的 .devlocal/test/qiniu.js 文件头），这个性质值得保住 ——
     一旦断言依赖真服务，"跑过了"就会变成"今天网络好"。

   ---- 地区为什么是 auto ----
   R2 的 SigV4 里 region 固定填 `auto`（它不分区，Cloudflare 文档明写）。
   填别的会被签名校验拒掉。
   ========================================================================== */

const ACCOUNT = process.env.R2_ACCOUNT_ID || '';
const AK = process.env.R2_ACCESS_KEY_ID || '';
const SK = process.env.R2_SECRET_ACCESS_KEY || '';
const BUCKET = process.env.R2_BUCKET || '';
const PUBLIC_BASE = (process.env.R2_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
const ENDPOINT = (process.env.R2_ENDPOINT
  || (ACCOUNT ? `https://${ACCOUNT}.r2.cloudflarestorage.com` : '')).replace(/\/+$/, '');

// 缺配置就在被 require 的那一刻炸掉，而不是等到某次上传莫名其妙失败。
// 和 app.js 里 `if (!process.env.SESSION_SECRET) throw` 是同一套路数。
{
  const missing = [];
  if (!AK) missing.push('R2_ACCESS_KEY_ID');
  if (!SK) missing.push('R2_SECRET_ACCESS_KEY');
  if (!BUCKET) missing.push('R2_BUCKET');
  if (!ENDPOINT) missing.push('R2_ENDPOINT（或 R2_ACCOUNT_ID）');
  if (!PUBLIC_BASE) missing.push('R2_PUBLIC_BASE_URL（或 R2_ACCOUNT_ID）');
  if (missing.length) throw new Error(`缺少 R2 配置：${missing.join('、')}，请检查 .env`);
}

// ★ 本机 IPv6 不通（/etc/gai.conf 全注释 = 默认 v6 优先，但 ShellCrash 的 TUN 只接管
//   IPv4），而 R2 的 endpoint 解析出 AAAA 就会走 v6 直连 → `connection reset`。
//   这和 CLAUDE.md 里 ghcr 拉不动的病根是同一个。**必须放在这里**（任何入口 require
//   本模块就生效，包括 scripts/ 下的那几个），别只放 app.js。
dns.setDefaultResultOrder('ipv4first');

const REGION = 'auto';
const SERVICE = 's3';
const ALGO = 'AWS4-HMAC-SHA256';

// 上传、删除这类请求经宿主机 ShellCrash 的全局 TUN 出去，代理一抖默认能吊很久，
// 而 POST /lineup 是**同步等 HEAD 结果**的 —— 不能让用户对着一个卡住的页面等 30 秒。
const TIMEOUT = Number(process.env.R2_TIMEOUT_MS || 15000);
// presigned URL 的有效期。浏览器拿到就开始传，10 分钟很宽裕；前端是**先压完再签名**，
// 所以这个有效期内不会夹着几分钟的客户端压缩（见 public/upload.js）。
const PUT_TTL = Number(process.env.R2_PUT_TTL || 600);

// ---------- 签名用的小工具 ----------

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// AWS 的 canonical 编码 = RFC3986（unreserved 只有 A-Za-z0-9-_.~）。
// encodeURIComponent 会把 `!'()*` 留着不编码，而 AWS 要求它们也编码，所以补一刀。
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g,
  (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// 头值规范化：去首尾空白 + 连续空白压成一个空格（AWS 要求）。
// 注意 `cache-control: public, max-age=31536000, immutable` 里的逗号**不动** ——
// 逗号不是空白，浏览器原样发出来就能对上。
const normHeaderValue = (v) => String(v).trim().replace(/\s+/g, ' ');

const amzDates = (now = new Date()) => {
  const amz = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return { amzDate: amz, dateStamp: amz.slice(0, 8) };
};

const signingKey = (dateStamp) =>
  hmac(hmac(hmac(hmac('AWS4' + SK, dateStamp), REGION), SERVICE), 'aws4_request');

// 一个 key 拆成路径段分别编码：key 里的 `/` 是**真的路径分隔符**，不能编码掉。
// 我们的 key 全是 `<uuid>.jpg` 或 `<uuid>.jpg.thumb.jpg`，本来不需要转义，
// 但迁移脚本可能搬进别的命名，编一遍是白送的保险。
const canonicalPath = (key) => '/' + BUCKET + '/' + key.split('/').map(enc).join('/');

/* ---------- ① presigned PUT ----------
   SigV4 的 presigned 形式：签名信息全放在查询串里，body 的哈希固定用
   `UNSIGNED-PAYLOAD`（我们本来就不在签发时读 body）。

   ★ 把哪些头放进 SignedHeaders 是这个函数最要紧的决定：
     · `content-type` 不签 → 客户端可以拿这张 URL 往**自己的图片域名**上传一个
       `Content-Type: text/html` 的 HTML，**在自己的图片域名下挂一个钓鱼页**。
     · `cache-control` 不签 → 对象上就没有我们那条一年 immutable，浏览器拿到 R2 的
       默认策略，"重刷时图片请求是 0"当场回归（README「缓存头」那段量过：20 张图
       逐张回问要 2.3s，并发挤一起实测到过 24.6s）。
   签进去之后浏览器必须发**逐字节一致**的值，否则 403 SignatureDoesNotMatch。
   所以这两个头由 /uploads/sign 随 URL 一起下发给前端，前端原样回传 ——
   签名头和实际请求头就永远不可能漂移。 */
function presignPut(key, headers = {}, { expires = PUT_TTL } = {}) {
  const { amzDate, dateStamp } = amzDates();
  const host = new URL(ENDPOINT).host;
  const uri = canonicalPath(key);

  const map = { host };
  for (const [k, v] of Object.entries(headers)) map[k.toLowerCase()] = normHeaderValue(v);
  const names = Object.keys(map).sort();
  const canonicalHeaders = names.map((n) => `${n}:${map[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const query = {
    'X-Amz-Algorithm': ALGO,
    'X-Amz-Credential': `${AK}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`).join('&');

  const canonicalRequest = [
    'PUT', uri, canonicalQuery, canonicalHeaders, signedHeaders, 'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = [ALGO, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = hmac(signingKey(dateStamp), stringToSign).toString('hex');

  return `${ENDPOINT}${uri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/* ---------- 带签名的普通请求（② ③ ④ ⑤ ⑥ 用）----------
   和 presign 的区别：签名放在 `Authorization` 头里，而且 body 的哈希是**真的**
   （没有 body 就用空串的哈希），不再用 UNSIGNED-PAYLOAD。

   ★ 查询串只收**对象**，规范化在这里做，调用方不许自己拼字符串。
     踩过的坑：`?delete` 原样当字符串传会被服务端规范化成 `delete=`，两边对不上就是
     403 SignatureDoesNotMatch（而且报错只说"签名不匹配"，特别难查）。
     同一个坑还有个潜伏形态 —— 自己拼串很容易忘了**按编码后的键排序**，
     单页请求碰巧顺序对所以看着正常，一旦参数多起来（`continuation-token` 排最后）
     就在翻页那一刻才开始挂。

   ★ **不签 `content-length`**：body 的完整性已经由 x-amz-content-sha256 覆盖了，
     再签一个 Node 自己也会设的头纯属多一处可能对不上的地方。它照发，只是不进签名。

   ★ **不加 `x-amz-checksum-*`**：R2 不实现那套，AWS SDK ≥3.729 默认会发，
     正是踩坑的地方；我们自己发请求就压根没有这一项。 */
function signedRequest(method, path, { query = {}, body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const { amzDate, dateStamp } = amzDates();
    const u = new URL(ENDPOINT);
    const mod = u.protocol === 'http:' ? http : https;
    const host = u.host;
    const payloadHash = sha256hex(body == null ? '' : body);

    // 规范查询串：编码 → 按键排序 → `k=v`（无值就是空串）。**发出去的和签的用同一个串**。
    const canonicalQuery = Object.entries(query)
      .map(([k, v]) => [enc(k), enc(v == null ? '' : String(v))])
      .sort((a, b) => (a[0] < b[0] ? -1 : (a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : 1))))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');

    const signed = { ...headers, host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const lower = {};
    for (const [k, v] of Object.entries(signed)) lower[k.toLowerCase()] = normHeaderValue(v);
    const names = Object.keys(lower).sort();
    const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
    const signedHeaders = names.join(';');

    const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
    const canonicalRequest = [
      method, path, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash,
    ].join('\n');
    const stringToSign = [ALGO, amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    const signature = hmac(signingKey(dateStamp), stringToSign).toString('hex');

    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      method,
      path: path + (canonicalQuery ? '?' + canonicalQuery : ''),
      headers: {
        ...signed,
        ...(body == null ? {} : { 'Content-Length': Buffer.byteLength(body) }),
        Authorization:
          `${ALGO} Credential=${AK}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      timeout: TIMEOUT,
    }, (res) => resolve(res));

    req.on('timeout', () => req.destroy(new Error(`R2 请求超时（${method} ${path}，${TIMEOUT}ms）`)));
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// 把响应体收完（小响应都用它；getObject 那种大流不走这儿）
async function drain(res) {
  const chunks = [];
  for await (const c of res) chunks.push(c);
  return Buffer.concat(chunks);
}

async function requestOk(method, path, opts = {}) {
  const res = await signedRequest(method, path, opts);
  const buf = await drain(res);
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`R2 ${method} ${path} → ${res.statusCode}：${buf.toString('utf8').slice(0, 300)}`);
  }
  return { res, buf };
}

/* ---------- ② HEAD ----------
   返回 { exists, size, type, cacheControl }。**404 不算错误**（它就是"没传上去"，
   是调用方要的正常答案之一），其它非 2xx 才抛。 */
async function head(key) {
  const res = await signedRequest('HEAD', canonicalPath(key));
  // HEAD 没有响应体，但要把连接放开，不然 socket 挂着
  res.resume();
  if (res.statusCode === 404) return { exists: false };
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`R2 HEAD ${key} → ${res.statusCode}`);
  }
  return {
    exists: true,
    size: Number(res.headers['content-length'] || 0),
    type: res.headers['content-type'] || '',
    cacheControl: res.headers['cache-control'] || '',
  };
}

/* ---------- ③ 批量删 ----------
   `POST /<bucket>?delete` + 一段 XML。S3 要求这个请求带 `Content-MD5`（R2 也认），
   而且它的 body 哈希是**真的** sha256（不是 UNSIGNED-PAYLOAD）。

   分片 1000：S3/R2 对一次 DeleteObjects 的硬上限。删整个赛期时会超，
   所以按 1000 切。**单 key 的失败写在响应体里、HTTP 仍是 200** ——
   体里每个 `<Error>` 记一行日志就够了（删除是幂等的：本来就不在也算成功）。 */
const DELETE_MAX = 1000;
const xmlEscape = (s) => String(s).replace(/[<>&'"]/g,
  (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));

async function removeKeys(keys) {
  const list = [...new Set((keys || []).filter(Boolean))];
  if (!list.length) return { deleted: [], errors: [] };

  const deleted = [];
  const errors = [];
  for (let i = 0; i < list.length; i += DELETE_MAX) {
    const slice = list.slice(i, i + DELETE_MAX);
    const xml = '<?xml version="1.0" encoding="UTF-8"?><Delete><Quiet>true</Quiet>'
      + slice.map((k) => `<Object><Key>${xmlEscape(k)}</Key></Object>`).join('')
      + '</Delete>';
    const body = Buffer.from(xml, 'utf8');
    try {
      const { buf } = await requestOk('POST', '/' + BUCKET, {
        query: { delete: '' },
        body,
        headers: {
          'Content-Type': 'application/xml',
          'Content-MD5': crypto.createHash('md5').update(body).digest('base64'),
        },
      });
      // Quiet 模式下成功的不回，只回 <Error>
      const text = buf.toString('utf8');
      const bad = [...text.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].map((m) => m[1]);
      deleted.push(...slice);
      for (const b of bad) {
        const k = (b.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1] || '?';
        const msg = (b.match(/<Message>([\s\S]*?)<\/Message>/) || [])[1] || '';
        errors.push(`${k}：${msg}`);
      }
    } catch (e) {
      // 整批失败：不能假装删掉了 —— 调用方（比如删赛期）要据此决定提示语
      errors.push(`整批 ${slice.length} 个失败：${e.message}`);
    }
  }
  return { deleted, errors };
}

/* ---------- ④ 服务端直传（迁移脚本用）----------
   不经 presign，所以没有签头约束 —— 头和对象元数据都在这里一次定死。
   CacheControl 必须在这儿写进去：R2 不会自己加。 */
async function putObject(key, buf, {
  type = 'image/jpeg',
  cacheControl = 'public, max-age=31536000, immutable',
} = {}) {
  await requestOk('PUT', canonicalPath(key), {
    body: buf,
    headers: { 'Content-Type': type, 'Cache-Control': cacheControl },
  });
  return buf.length;
}

/* ---------- ⑤ 下载（备份 / 回滚）----------
   返回的是**流**，不是 Buffer：备份要把整个桶拉回来，整块进内存没必要。
   调用方负责 consume。 */
async function getObject(key) {
  const res = await signedRequest('GET', canonicalPath(key));
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`R2 GET ${key} → ${res.statusCode}`);
  }
  return res;
}

/* ---------- ⑥ 列全量 ----------
   ListObjectsV2 回的是 XML。这里用正则抓而不是引一个 XML 库 —— 理由：
     · 它只出现在备份 / GC / 迁移核对里，**不在请求路径上**；
     · 我们的 key 字符集是 `[0-9a-f-]{36}.jpg(.thumb.jpg)?`，没有需要反转义的字符
       （仍然过一遍 unescape 兜底）；
     · 这个仓库的既有取舍是能不加依赖就不加。
   **必须翻页**：默认一次 1000 个，靠 IsTruncated + NextContinuationToken 接着要。
   而 `pageSize` 这个旋钮是**留给测试的**：默认 1000 时，桶里对象不够多就永远只走一页，
   翻页那条路测不到 —— 测不到的代码会烂掉（这个仓库为这件事吃过苦头：三套断言都是
   因为"没有跑法脚本就没人再跑"而悄悄坏掉的）。断言里传个小值就能强制翻页。 */
const xmlUnescape = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

async function listAll({ prefix = '', pageSize = 1000 } = {}) {
  const out = [];
  let token = '';
  for (;;) {
    const query = { 'list-type': '2', 'max-keys': String(pageSize) };
    if (prefix) query.prefix = prefix;
    if (token) query['continuation-token'] = token;
    const { buf } = await requestOk('GET', '/' + BUCKET, { query });
    const text = buf.toString('utf8');

    for (const m of text.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const blk = m[1];
      const key = (blk.match(/<Key>([\s\S]*?)<\/Key>/) || [])[1];
      if (key == null) continue;
      out.push({
        key: xmlUnescape(key),
        size: Number((blk.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0),
        lastModified: xmlUnescape((blk.match(/<LastModified>([\s\S]*?)<\/LastModified>/) || [])[1] || ''),
      });
    }

    if (!/<IsTruncated>true<\/IsTruncated>/.test(text)) break;
    token = xmlUnescape((text.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/) || [])[1] || '');
    if (!token) break;   // 真被截断了却没给 token：宁可停，也别死循环
  }
  return out;
}

// 公开域名下的图片地址。**这是全站拼图片 URL 的唯一出口**（app.js 的 locals 与
// 老链接 302 都走它），域名只从 .env 来，模板和 JS 里一个字都不硬编码。
const publicUrl = (key) => `${PUBLIC_BASE}/${key}`;

/* ---------- 桶的 CORS ----------
   浏览器**直传**必须有它：没有 CORS 时跨域 PUT 会被预检挡掉，上传全失败。
   这是桶侧配置（不在仓库里），所以写成函数 + 一个可重跑的命令，别只在面板里点一次
   —— 否则换桶、重建桶、或者干脆忘了配过什么，没人知道该配成什么样。

   ★ AllowedOrigins 必须**把本站的每个入口都写上，而且带端口**：本站有两个入口
     （一个走隧道、一个走公网直连，见 deploy/nginx-yanwu.conf）。
     CORS 的 origin 是包含端口的，只写一个的话另一条入口的用户全都传不了图。
     真实取值不进这个文件 —— 它在 deploy/DEPLOY.md 里（那份是本机专属、不进公开仓库）。

   ★ AllowedHeaders 必须盖住**签进签名的那两个头**（content-type / cache-control）：
     预检不放行它们，浏览器根本发不出这个 PUT。 */
async function setCors(origins) {
  const xml = '<?xml version="1.0" encoding="UTF-8"?><CORSConfiguration><CORSRule>'
    + origins.map((o) => `<AllowedOrigin>${xmlEscape(o)}</AllowedOrigin>`).join('')
    + '<AllowedMethod>PUT</AllowedMethod>'
    + '<AllowedHeader>content-type</AllowedHeader>'
    + '<AllowedHeader>cache-control</AllowedHeader>'
    + '<ExposeHeader>ETag</ExposeHeader>'
    + '<MaxAgeSeconds>3600</MaxAgeSeconds>'
    + '</CORSRule></CORSConfiguration>';
  const body = Buffer.from(xml, 'utf8');
  await requestOk('PUT', '/' + BUCKET, {
    query: { cors: '' },
    body,
    headers: {
      'Content-Type': 'application/xml',
      'Content-MD5': crypto.createHash('md5').update(body).digest('base64'),
    },
  });
  return origins;
}

module.exports = {
  presignPut, head, removeKeys, putObject, getObject, listAll, publicUrl, setCors,
  BUCKET, ENDPOINT, PUBLIC_BASE, PUT_TTL,
};
