/* 「复制战报」那一下（/seasons/:id 上，见 views/season.ejs）。
   只干一件事：把那段纯文本全选上，剩下的交给用户 —— 手机上长按选「复制」，
   桌面上按 Ctrl/Cmd+C。顺手试一下 execCommand('copy')，能成就连这一步也省了。

   ⚠️ 这里**故意不碰 navigator.clipboard**，别看着"落后"就想换掉：
   本站只有 HTTP（nginx 只听 80、没有证书、也不打算上），而它不是安全上下文 ——
   Chrome / Firefox 上 navigator.clipboard **干脆就是 undefined**，写了也是白写，
   而为了它套一层 try/catch 只会让人以为"复制功能是好的，只是有时候失败"。
   execCommand 虽然标着废弃，却是唯一在 HTTP 下能真复制的路子，而且到处都还认它。

   **是增强不是依赖**（和 lightbox.js / comments.js 同一个约定）：脚本没加载时，
   文本框照样能长按选中、Ctrl+A 选中 —— 少的是一个按钮，不是功能。
   脚本挂在页脚，DOM 已经解析完，不用等 DOMContentLoaded。 */
(function () {
  'use strict';
  var ta = document.getElementById('report-text');
  var btn = document.getElementById('report-select');
  if (!ta || !btn) return;                    // 别的页面没有这一段

  var hint = document.getElementById('report-hint');
  var say = function (msg) { if (hint) hint.textContent = msg; };
  var CLEAR = hint ? hint.textContent : '';   // 模板里那句"手机上长按…"，忙完再放回去

  btn.addEventListener('click', function () {
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);   // iOS Safari 上光 select() 常常选不全
    var copied = false;
    try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
    say(copied ? '已复制，去群里粘贴吧' : '已全选 —— 长按这段文字选「复制」');
    // 三秒后放回原来的提示，免得一句"已复制"一直挂在那儿，下次进来以为是刚复制的
    setTimeout(function () { say(CLEAR); }, 3000);
  });
})();
