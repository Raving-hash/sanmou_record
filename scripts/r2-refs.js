const Database = require('better-sqlite3');

/* ==========================================================================
   "库里引用了哪些图片对象" —— **只此一处**。

   迁移（migrate-to-r2）、孤儿回收（r2-gc）、备份核对都要这个集合，
   三份拷贝迟早会改岔（这个仓库为这件事吃过苦头：README 里
   「抄一份到脚本里迟早会和这里改岔」那句就是这么来的）。

   ★ 缩略图**不在库里单独存** —— 它由原图名字推出来（`<name>.thumb.jpg`），
     所以引用集 = 原图 ∪ 各自的缩略图。删图也是同一套推导（见 upload.js 的 expand）。
   ========================================================================== */

const THUMB_SUFFIX = '.thumb.jpg';

// 返回 Set<string>：所有**应该存在**的对象 key
function dbRefs(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const originals = [
      ...db.prepare('SELECT filename AS f FROM lineup_images').all(),
      ...db.prepare('SELECT score_image AS f FROM entries WHERE score_image IS NOT NULL').all(),
    ].map((r) => r.f).filter(Boolean);

    const set = new Set();
    for (const f of originals) {
      set.add(f);
      set.add(f + THUMB_SUFFIX);
    }
    return set;
  } finally {
    db.close();
  }
}

module.exports = { dbRefs, THUMB_SUFFIX };
