// 同一 IP 失败 10 次锁 15 分钟。存在内存里，重启后清零，自用足够
const fails = new Map();
const WINDOW = 15 * 60e3;
const MAX_FAILS = 10;

exports.isLocked = (ip) => {
  const f = fails.get(ip);
  return !!f && f.n >= MAX_FAILS && Date.now() < f.until;
};
exports.addFail = (ip) => {
  const f = fails.get(ip);
  const n = f && Date.now() < f.until ? f.n + 1 : 1;
  fails.set(ip, { n, until: Date.now() + WINDOW });
};
exports.clear = (ip) => fails.delete(ip);

// ---------- 游客发评论的限流 ----------
// 同一 IP 5 秒最多 1 条、1 小时最多 30 条。**只管游客**：成员有身份、有人盯着，
// 而且不少成员共用一个出口 IP，按 IP 限他们等于连坐。
// 和上面登录失败那套分开两张表：一个记"失败次数"，一个记"成功发表的速率"，语义不同。
// 按 IP 分桶换 IP 就能绕，但能换 IP 的只有命令行；刷屏的主体是网页，网页换不了 IP。
const HITS = new Map();                 // ip → 最近一小时内成功发表的时间戳
const FAST = 5e3;                       // 两条之间至少隔这么久
const HOUR = 3600e3;
const HOUR_MAX = 30;

// 放行返回 null；不放行返回一句**直接进 flash 给用户看**的话。
// 只在真的写进库之后才算一次（见 routes/public.js）：打错字、超长被拒不该吃额度。
exports.guestCommentWait = (ip) => {
  const now = Date.now();
  const hits = (HITS.get(ip) || []).filter((t) => now - t < HOUR);
  HITS.set(ip, hits);                   // 顺手把过期的时间戳清掉
  if (hits.some((t) => now - t < FAST)) return '发得太快啦，歇几秒再发';
  if (hits.length >= HOUR_MAX) return `一小时内最多 ${HOUR_MAX} 条，过会儿再来`;
  return null;
};
exports.noteGuestComment = (ip) => {
  const hits = HITS.get(ip) || [];
  hits.push(Date.now());
  HITS.set(ip, hits);
};

// ---------- 签发上传令牌的限流 ----------
// 图片直传 R2 之后唯一能防"登录用户把桶当免费图床"的闸门：/uploads/sign 的配额预检
// 挡的是"本期的阵容额度"，挡不住同一个人反复 sign 又不提交 —— 那些对象会变成孤儿
// （GC 会清，但白白给桶灌垃圾、也白白占带宽）。
//
// 按 **uid** 而不是 IP：能 sign 的一定是登录用户，而不少成员共用一个出口 IP，
// 按 IP 限他们等于连坐（和上面游客评论那条同一个理由）。
// 语义也不同：那两张表记的是"失败次数"和"发表速率"，这张记的是"签出去的 key 数"。
const SIGNS = new Map();                 // uid → 最近一小时内签出去的 key 时间戳
const SIGN_MAX = Number(process.env.SIGN_HOUR_MAX || 120);

// 放行返回 null；不放行返回一句直接给用户看的话。count = 这一次要签几个 key。
exports.signWait = (uid, count) => {
  const now = Date.now();
  const hits = (SIGNS.get(String(uid)) || []).filter((t) => now - t < HOUR);
  SIGNS.set(String(uid), hits);
  if (hits.length + count > SIGN_MAX) return `一小时最多传 ${SIGN_MAX} 张，过会儿再来`;
  return null;
};
// n 个 key 记 n 次（一次 sign 可能要点 6 张）
exports.noteSign = (uid, n) => {
  const hits = SIGNS.get(String(uid)) || [];
  for (let i = 0; i < n; i++) hits.push(Date.now());
  SIGNS.set(String(uid), hits);
};

// 顺手清掉过期条目，避免长时间运行内存里攒一堆 IP
exports.sweep = () => {
  const now = Date.now();
  for (const [ip, f] of fails) if (now >= f.until) fails.delete(ip);
  for (const [ip, hits] of HITS) {
    const keep = hits.filter((t) => now - t < HOUR);
    if (keep.length) HITS.set(ip, keep); else HITS.delete(ip);
  }
  for (const [uid, hits] of SIGNS) {
    const keep = hits.filter((t) => now - t < HOUR);
    if (keep.length) SIGNS.set(uid, keep); else SIGNS.delete(uid);
  }
};
setInterval(exports.sweep, 30 * 60e3).unref();
