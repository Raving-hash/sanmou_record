// 管理员代成员操作（2026-10-22 加）—— 全站**唯一**的“这次动手的是谁”判据。
//
// /lineup 和 /score 原本永远只写当前登录者自己的 entries 行。现在管理员可以替
// 任何一个成员传阵容、填积分，于是每一条写入口都要先回答同一个问题：
// “这次是本人，还是管理员代别人？”把这个问题收在这里，免得路由里各写一份
// （漏掉一处就是越权写入，或者管理员点了链接却静默写回自己）。
//
// 口径：
//   · 没传 uid、或者传的就是自己 —— 本人，self: true；
//   · 传了别人的 uid —— 必须是管理员；否则 error。管理员可以代**任何成员**，
//     包括被禁用的（禁用只挡本人登录，管理员仍有管理历史数据的口子，
//     和现有 /lineup/:id/delete 允许管理员删任意成员图片是同一个口径）；
//   · uid 查无此人 —— error。
//
// 注意这里**只判“谁被操作”**，不判赛期、窗口、额度 —— 那些仍由各路由自己管。
const db = require('./db');

// 表单里同名字段重复出现时 Express 给的是数组。取第一个就够了，也免得
// String(['a','b']) 拼成 "a,b" 去查库。
const first = (v) => (Array.isArray(v) ? v[0] : v);
const uidOf = (v) => String(first(v) ?? '').trim().toLowerCase();

function resolve(actor, rawUid) {
  if (!actor) return { error: '请先登录' };
  const uid = uidOf(rawUid);
  const selfUid = String(actor.user_id || '').toLowerCase();

  if (!uid || uid === selfUid) return { user: actor, self: true };
  if (!actor.is_admin) return { error: '只有管理员能替别的成员操作' };

  const target = db.getUserByUid(uid);
  if (!target) return { error: '没有这个成员' };
  return { user: target, self: false };
}

// 这次上传按哪一段窗口处理（2026-10-22 用户定的）：**管理员不受窗口限制** ——
// 窗口还没开时照传，按“完整阵容图”入库（进识别、计入统计）；窗口开着时仍按当时阶段
// （初步 / 完整）。**只放宽时间，不放宽 MAX_LINEUP**：每人每期一张照旧，
// 目标已经有完整图时仍然要先删再传。
function phaseFor(actor, phase) {
  if (phase === 'closed' && actor?.is_admin) return { phase: 'full', override: true };
  return { phase, override: false };
}

module.exports = { resolve, phaseFor };
