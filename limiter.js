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

// 顺手清掉过期条目，避免长时间运行内存里攒一堆 IP
exports.sweep = () => {
  const now = Date.now();
  for (const [ip, f] of fails) if (now >= f.until) fails.delete(ip);
};
setInterval(exports.sweep, 30 * 60e3).unref();
