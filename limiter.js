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

// 顺手清掉过期条目，避免长时间运行内存里攒一堆 IP
exports.sweep = () => {
  const now = Date.now();
  for (const [ip, f] of fails) if (now >= f.until) fails.delete(ip);
  for (const [ip, hits] of HITS) {
    const keep = hits.filter((t) => now - t < HOUR);
    if (keep.length) HITS.set(ip, keep); else HITS.delete(ip);
  }
};
setInterval(exports.sweep, 30 * 60e3).unref();
