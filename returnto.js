// 回跳白名单（2026-10-17 加）。
//
// 打分、阵容纠错、评论、删评论这几条 POST 现在都可能从**带筛选参数的墙**上发出，
// 回跳不能只认 '/' 和 '/wall' 两个硬编码值（那会把筛选丢掉），也不能拿表单里的
// 字符串直接拼 Location（开放重定向 / 头注入）。所以统一走这里：
//
//   允许：
//     /                         首页（首页墙的默认地址）
//     /wall                     游客/成员都能看的公开墙
//     /seasons/<id>/wall        历史赛期墙
//     /?<query>                 首页墙的筛选参数（query 里不能有 #、空白、反斜杠）
//   其余一律退回 fallback。
//
// seasonId 可选：传了的话，/seasons/<id>/wall 必须正好是这一期 —— 从 A 期的卡
// 回跳到 B 期的墙没有意义，而且越少让表单决定目标越好。不传则不限赛期。
//
// 注意**只认站内绝对路径**：'//evil.example' 不是以 '/?' 开头，也不等于 '/'
// 或 '/wall'，会被 fallback 挡掉；'https://evil.example' 同理。
const SEASON_WALL = /^\/seasons\/(\d+)\/wall$/;
const HOME_QUERY = /^\/\?[^#\s\\]*$/;

function safe(raw, fallback = '/', { seasonId = null } = {}) {
  const s = String(raw || '');
  if (s === '/' || s === '/wall') return s;

  const m = s.match(SEASON_WALL);
  if (m) {
    if (seasonId === null || Number(m[1]) === Number(seasonId)) return s;
    return fallback;
  }

  if (HOME_QUERY.test(s)) return s;
  return fallback;
}

module.exports = { safe };
