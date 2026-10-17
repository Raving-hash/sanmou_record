// 积分录入接口（2026-10-17 加）—— 给 Windows 端的 OCR 程序用。
//
// 它解决的是"积分截图已经不用传了，但一个个手填还是麻烦"：
// Windows 端把玩家列表认出来之后，直接拿**游戏名 + 积分**来这儿落账。
// 本站的登录 ID / 昵称都不是游戏里显示的名字，所以 users 表另加了 `game_name`
// （见 schema.sql 与 db.js 的迁移块）；本接口按它反查用户。
//
// ★ 认证**不是**浏览器会话：调这个接口的是桌面程序，没有 cookie。
//   令牌放在 .env 的 SCORE_API_TOKEN 里，走 `Authorization: Bearer <token>`
//   或 `X-Api-Token: <token>`。没配这个键 = 接口整体不启用（503），
//   和之前的 OCR_URL 一个路数：不配就没有这个功能，不影响站点其它部分。
//   管理员在自己的浏览器里调试时，登录会话也可以直接用（见 authorized）。
//
// ★ 语义是**覆盖**：同一个游戏名再发一次，就把本期积分改成新值，不累加。
//   分数变了才刷新 score_submitted_at；分数没变就保持原时间 ——
//   和 /score 那条本人录分的规矩完全一致（同分时名次按提交时间排，见 db.getRanking）。
//   老库里可能还留着的积分截图（score_image）**不动**：那是用户自己的东西，
//   接口只负责"分"；要清走「撤回积分」。
//
// 请求体两种形状都收（Windows 端一次认出一屏通常有好几条）：
//   单条：      {"game_name": "张三", "score": 1234}
//   批量：      [{"game_name": "张三", "score": 1234}, {"game_name": "李四", "score": 987}]
//   也认驼峰 gameName，省得客户端拼错一次就全挂。
//
// 回包永远是 HTTP 200 + 逐条结果（除了认证 / 赛期 / 报文本身有问题）：
//   {
//     "ok": true, "season": "第32期", "updated": 2,
//     "results": [
//       { "game_name": "张三", "status": "ok", "user_id": "zhangsan",
//         "nickname": "张三", "score": 1234, "previous": 1200, "changed": true },
//       { "game_name": "王五", "status": "unknown", "error": "没有这个游戏名对应的用户" }
//     ]
//   }
//   status 取值：ok / unknown（游戏名没人认领）/ disabled（账号被禁用）/ invalid（这条报文不合法）。
//   —— 批量调用里一条坏数据不该把整批打回，所以坏的那条就地报错，好的照写。

const crypto = require('crypto');
const express = require('express');
const db = require('../db');

const router = express.Router();

const SCORE_RE = /^\d{1,9}$/;
const MAX_ITEMS = 100;              // 一屏最多几十个人，100 足够，也挡住了拿它当批量写库用

// 这个接口只收 JSON（Windows 端拼 JSON 最省事）。体积给 128KB：
// 100 条游戏名 + 分数也就几 KB，留够余量即可。
// 注意 app.js 里还有全局的 express.urlencoded：表单形状（game_name=…&score=…）
// 也能被解析，顺手兼容 curl 手测。
router.use(express.json({ limit: '128kb' }));

// 坏 JSON / 体积超限要回 JSON，不能落到全局那个纯文本处理器上 ——
// 桌面端是按 content-type 解析的，拿到一坨 HTML 只会报一个看不懂的错。
// 只认 body-parser 的这两种错，其它错误照旧往上抛（别把数据库错误也说成"JSON 坏了"）。
router.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: '请求体不是合法的 JSON' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: '请求体太大' });
  }
  next(err);
});

// 定长的比较，别用 === 直接比字符串（令牌长度固定时差异可以忽略，
// 但写起来也就多两行，没有理由留一个理论上的时序侧信道）。
const tokenMatches = (given) => {
  const expected = process.env.SCORE_API_TOKEN || '';
  if (!expected || !given) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

// 两种放行方式：
//   · 令牌（Windows 端）；
//   · 已登录的**管理员**（自己的浏览器 / curl 带 cookie 手测时省得再掏令牌）。
//     不放开给普通玩家：他们已经有 /score 那条本人录分的路了。
const authorized = (req) => {
  if (req.user?.is_admin) return true;
  const bearer = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  return tokenMatches(bearer || String(req.get('x-api-token') || '').trim());
};

const parseScore = (v) => {
  if (typeof v === 'number') {
    return Number.isInteger(v) && v >= 0 && v <= 999999999 ? v : null;
  }
  const s = String(v ?? '').trim();
  return SCORE_RE.test(s) ? Number(s) : null;
};

router.post('/scores', (req, res) => {
  if (!process.env.SCORE_API_TOKEN) {
    return res.status(503).json({
      ok: false,
      error: '接口未启用：服务端没有配置 SCORE_API_TOKEN',
    });
  }
  if (!authorized(req)) {
    return res.status(401).json({ ok: false, error: '缺少或错误的访问令牌' });
  }

  // 积分永远记在**当前进行中的那一期**上：接口不指定赛期，免得 Windows 端
  // 把上一期的分写进这一期。没有进行中的期就整批拒绝 —— 让它静默成功才是坑。
  const season = db.getOpenSeason();
  if (!season) {
    return res.status(409).json({ ok: false, error: '当前没有进行中的赛期' });
  }

  // 没带 Content-Type / 空 body 时 express 给的是 undefined（form 形状则是 {}），
  // 这两种都当"报文是空的"打回；{} 会走下面的逐条校验，报 game_name 不能为空。
  if (req.body === undefined || req.body === null) {
    return res.status(400).json({ ok: false, error: '请求体是空的' });
  }
  const items = Array.isArray(req.body) ? req.body : [req.body];
  if (!items.length) return res.status(400).json({ ok: false, error: '请求体是空的' });
  if (items.length > MAX_ITEMS) {
    return res.status(400).json({ ok: false, error: `一次最多提交 ${MAX_ITEMS} 条` });
  }

  // 整批一个事务：要么一起落库（逐条状态照实回报），要么一条都不写。
  // 这里没有 await，better-sqlite3 又全是同步调用，所以中间插不进第二个请求。
  const results = [];
  db.transaction(() => {
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        results.push({ status: 'invalid', error: '每一条都必须是对象' });
        continue;
      }
      const gameName = String(item.game_name ?? item.gameName ?? '').trim();
      const score = parseScore(item.score);
      const base = { game_name: gameName };

      if (!gameName) {
        results.push({ ...base, status: 'invalid', error: 'game_name 不能为空' });
        continue;
      }
      if (score === null) {
        results.push({ ...base, status: 'invalid', error: 'score 必须是 0–999999999 的整数' });
        continue;
      }

      const user = db.getUserByGameName(gameName);
      if (!user) {
        results.push({ ...base, score, status: 'unknown', error: '没有这个游戏名对应的用户' });
        continue;
      }
      if (user.is_disabled) {
        results.push({
          ...base, score, status: 'disabled', user_id: user.user_id,
          nickname: user.nickname, error: '这个账号已被禁用',
        });
        continue;
      }

      const entry = db.getOrCreateEntry(season.id, user.id);
      const previous = entry.score;
      const changed = previous !== score;
      // 和 /score 同一口径：分变了才刷新提交时间；分没变就保留原时间
      // （名次同分时按它排，见 db.getRanking）。
      const submittedAt = changed || !entry.score_submitted_at
        ? new Date().toISOString()
        : entry.score_submitted_at;
      db.prepare('UPDATE entries SET score=?, score_submitted_at=? WHERE id=?')
        .run(score, submittedAt, entry.id);

      results.push({
        ...base, score, status: 'ok',
        user_id: user.user_id, nickname: user.nickname,
        previous, changed,
      });
    }
  })();

  res.json({
    ok: true,
    season: season.name,
    updated: results.filter((r) => r.status === 'ok').length,
    results,
  });
});

module.exports = router;
