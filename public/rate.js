/* 打分**不刷新页面**（2026-10-21 用户要求：「打分以后有个短暂的卡顿刷新，
   现在希望直接切换分数就好，不要刷新页面不要卡顿」）。

   从前点一个档位就是一次原生表单 POST，服务端 302 跳回 `/#e<id>` —— 整页重下、
   重画、重新对齐一遍，用户看到的就是"闪一下"。

   现在的做法：
     1. 拦住 .rate-form 的提交，用 fetch 带上 X-Rate-Ajax 头；
     2. **先**把点中的那一档高亮起来、"你打了 X"也立即换成新的（乐观更新）——
        服务端来回只有几十毫秒，等它再画就是可感的延迟；
     3. 服务端回 JSON，里面带着**重新渲染好的三块 HTML**（见 routes/main.js）：
          · rateHtml  这张卡的整个 .shot-rate（均分/最高/最低/慧眼王 + 我打的 + 按钮）
          · quotaHtml 墙上那行「本期你的打分名额」
          · todoHtml  首页待办里的打分那一条（"已投 N 套"）
        整块换掉，然后让 wall.js 重新对齐（打分区高度会变）、让 home-filter.js
        重算可见性（首页可能正在按"我打没打过分"筛着）。
     4. 失败（名额满了、刚封盘、网络问题）→ 用**先存下的那份 HTML** 把乐观更新退回去，
        底部弹一条提示。不能留着一个假装投上了的高亮。

   **是增强不是依赖**：脚本没加载时表单照旧 POST + 跳转，功能一个不少。
   先高亮再等回包有个前提：服务端是唯一判官。它说不行就整块退回（见 restore），
   所以乐观更新永远不会留在错误的状态上。 */
(function () {
  'use strict';

  var TOAST_MS = 3600;
  var toastEl = null;
  var toastTimer = 0;

  // 底部一条小提示（失败原因、或者"你打的就是这一档"）。用 aria-live 报给读屏，
  // 不做成页面里的 flash —— 那会挤动版面，而这里要的恰恰是"不跳"。
  function toast(msg) {
    if (!msg) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, TOAST_MS);
  }

  // 乐观更新：不等服务端，先把"我选了这一档"画出来。
  // 只动两处 —— 五个按钮的 .is-mine，和 .rate-tail 顶上那句「你打了 X」。
  // 均分/最高/最低**不猜**：那要重算一遍汇总，猜错了再改回来比不做还晃眼。
  function optimistic(rate, value) {
    var form = rate.querySelector('.rate-form');
    if (!form) return;
    var btns = form.querySelectorAll('.rate-tier');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var mine = b.value === value;
      b.classList.toggle('is-mine', mine);
    }
    var tail = rate.querySelector('.rate-tail');
    if (!tail) return;
    var line = tail.querySelector('.rate-mine');
    if (!line) {
      line = document.createElement('p');
      line.className = 'rate-mine';
      tail.insertBefore(line, tail.firstChild);
    }
    line.innerHTML = '你打了 <b></b>';
    line.querySelector('b').textContent = value;   // 纯数字，不用拼 HTML
  }

  // 把打分区换回提交前那一版（失败时用）。传进来的是 outerHTML 字符串 ——
  // 直接改类名再逐个属性恢复太容易漏，整块还原最稳。
  function restore(card, html) {
    var now = card.querySelector('.shot-rate');
    if (now) now.outerHTML = html;
  }

  // 换一块可选的元素：页面上没有它（比如首页待办只在首页有）就什么都不做。
  function replaceOptional(sel, html) {
    var el = document.querySelector(sel);
    if (!el) return;
    if (html) el.outerHTML = html;
    else if (el.parentNode) el.parentNode.removeChild(el);
  }

  // 换完之后把版面收拾好：
  //   · 打分区高度变了（多了「你打了 X」那两行）—— wall.js 会把同排的卡重新撑齐；
  //   · 首页可能正按 data-rated 筛着（public/home-filter.js）—— 让它重算可见性，
  //     它自己会再喊一次 wall.js。两个函数都可能不存在（别的页面/没引脚本），所以都判一下。
  function settle() {
    if (typeof window.ywFilterApply === 'function') window.ywFilterApply();
    if (typeof window.ywWallRefresh === 'function') window.ywWallRefresh();
  }

  function send(form, btn, card) {
    var rate = card.querySelector('.shot-rate');
    var before = rate.outerHTML;              // 失败时原样退回去
    // 键盘投的票：整块换掉之后原来那个按钮就不在了，焦点会掉到 body 上 ——
    // 记一下，换完再把焦点放回同一档的新按钮。鼠标点的（按钮本来就没焦点）不动它。
    var hadFocus = document.activeElement === btn;
    form.setAttribute('data-busy', '1');
    optimistic(rate, btn.value);

    var body = new URLSearchParams();
    body.set('value', btn.value);             // 按钮上的 value 不会自己进 FormData
    var rt = form.elements.returnTo;          // 没 JS 时用来跳回带筛选的那一版墙
    if (rt) body.set('returnTo', rt.value);

    function done() {
      var f = card.querySelector('.rate-form');
      if (f) f.removeAttribute('data-busy');
    }

    fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Rate-Ajax': '1', Accept: 'application/json' },
      body: body,
    }).then(function (res) {
      // 会话过期时这个 POST 会被 requireLogin 弹去登录页（fetch 默认跟 302）。
      // 拿到的就是一张登录页 HTML，res.json() 会抛 —— 直接说清楚，别报成"网络不好"。
      if (res.redirected) throw new Error('登录状态过期了，刷新一下再打分');
      // 业务上的拒绝也是 200 + { ok:false }；这里只把"根本不是 JSON"（代理/网关的
      // 错误页）当成失败抛出去。
      return res.json();
    }).then(function (j) {
      done();
      if (!j || !j.ok) {
        restore(card, before);
        toast((j && j.msg) || '没投上去，再点一次试试');
        return;
      }
      // 点的是原来那一档：服务端一个字都没写，DOM 也不用动（高亮本来就是它）。
      if (j.changed === false) { toast(j.msg); return; }
      if (j.rateHtml) {
        var now = card.querySelector('.shot-rate');
        if (now) now.outerHTML = j.rateHtml;
        if (hadFocus) {
          var nb = card.querySelector('.rate-tier[value="' + btn.value + '"]');
          if (nb) nb.focus();
        }
      }
      card.setAttribute('data-rated', j.rated ? '1' : '0');
      replaceOptional('.quota-line', j.quotaHtml);
      replaceOptional('[data-todo-rate]', j.todoHtml);
      settle();
    }).catch(function (err) {
      done();
      restore(card, before);
      toast((err && err.message) || '网络不太好，这一票没投上去');
    });
  }

  // 没有 fetch / URLSearchParams / closest 的老浏览器：一个人都不拦，
  // 全部交给原生提交（和从前一样）。**这两个判断必须在拦提交之前** —— 拦了才发现
  // 用不了，就等于把按钮废掉。
  if (typeof window.fetch !== 'function' || typeof window.URLSearchParams !== 'function'
      || typeof Element.prototype.closest !== 'function') return;

  // 只接阵容卡上那一个 form。别的表单（筛选、评论、纠错）一概不碰。
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || !form.classList || !form.classList.contains('rate-form')) return;
    if (e.defaultPrevented) return;
    // e.submitter 是"哪个按钮触发的提交"（回车提交时可能是 null）——
    // 拿不到、或者它不是档位按钮，就**不拦**：交给浏览器走原生 POST，功能和从前一样。
    var btn = e.submitter;
    if (!btn || btn.name !== 'value' || btn.disabled) return;
    // 上一票还在飞：拦下，别叠第二次（连点两下不能投两票 / 来回改分）。
    if (form.getAttribute('data-busy') === '1') { e.preventDefault(); return; }
    // 结构不对（万一模板改了、这张表单不在 .shot-card 里）也交给原生提交 ——
    // **preventDefault 要放在所有"能不能接住"的判断之后**，否则按钮会变成死的。
    var card = form.closest('.shot-card');
    if (!card || !card.querySelector('.shot-rate')) return;
    e.preventDefault();
    send(form, btn, card);
  });
})();
