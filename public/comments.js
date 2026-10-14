/* 只干一件事：带着 #e<id> 锚点进来时，把那张卡的评论区展开。
   为什么需要它：发表/删除评论是"重定向回那张卡"（PRG，见 routes/public.js），
   而评论区默认是折叠的（<details>）—— 不展开的话，用户看到的就是"我发的评论不见了"。
   **是增强不是依赖**：脚本没加载时手点一下 ▸ 照常能用，和 lightbox.js 同一个约定。
   脚本挂在页脚，DOM 已经解析完了，不用等 DOMContentLoaded。
   锚点挂在 <figure> 上，展开只会让它往下长，不会把页面顶偏。 */
(function () {
  'use strict';
  var m = /^#e(\d+)$/.exec(location.hash);
  if (!m) return;
  var card = document.getElementById('e' + m[1]);
  if (!card) return;
  var box = card.querySelector('details.cmt');
  if (box) box.open = true;
})();
