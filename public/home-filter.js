/* 首页阵容墙：换「武将」**不刷新页面**，直接收放卡片（2026-10-19 用户要求）。
 *
 * 为什么这么做：筛选从前是一张纯 GET 表单，选完点「筛选」整页重排 —— 就为了看某几个
 * 武将的阵容，页面要重下、重画一遍。武将名单有 102 个，玩家在首页挨个点过去时这一下很烦。
 *
 * 数据从哪来：服务端现在把**全部**卡片都渲染出来（routes/main.js 的 visibleIds），
 * 不匹配当前筛选的卡片挂 .is-hidden（CSS 里就是 display:none）。于是：
 *   · 没有 JS：.is-hidden 照旧藏着，GET 表单提交后看到的和从前一模一样；
 *   · 有 JS：这里只改 .is-hidden，卡片一直在 DOM 里，换回去就再露出来。
 *
 * 三个属性（views/partials/lineup-gallery.ejs）：
 *   data-heroes       这张卡第一张图里的武将 key，空格分隔 —— 换武将时按它匹配；
 *   data-rest-hidden  这张卡被「武将以外」的条件筛掉了（势力/积分/昵称…）——
 *                     换武将时它必须继续藏着，否则会把别的筛选结果一起放出来；
 *   data-filter-note / [data-wall-empty] / [data-filter-reset] 都是现写现收的文案与按钮。
 *
 * 还有两件容易漏的事：
 *   ① 打分/评论/纠错表单里的 hidden returnTo 是**服务端渲染那一刻**的地址。不刷新页面时
 *      它就过期了 —— 投完票会跳回旧筛选。所以这里每次筛选都把 .shot-grid 里的
 *      returnTo 改写成当前地址。
 *   ② public/wall.js 已经把墙拆成 .shot-col 竖列了，藏掉几张卡之后必须让它重新分列、
 *      重新对齐，否则那几列里会留下空洞。这里改完喊一声 window.ywWallRefresh()。
 *
 * 没 JS / 不是首页：第一行就退出，不影响任何页面。
 */
(function () {
  'use strict';

  var form = document.querySelector('form.wall-filter');
  if (!form) return;
  var grid = document.querySelector('.shot-grid');
  if (!grid) return;
  var heroSel = form.elements.hero;
  if (!heroSel) return;

  var cards = [].slice.call(grid.querySelectorAll('.shot-card'));
  if (!cards.length) return;

  var note = document.querySelector('[data-filter-note]');
  // 「清除筛选」有两处：表单里那个按钮，和"没有符合筛选的阵容"那段里的链接。
  // 两处都接过来，点哪个都不刷新页面。
  var resets = [].slice.call(document.querySelectorAll('[data-filter-reset]'));
  var emptyFilter = document.querySelector('[data-wall-empty="filter"]');
  var emptyNone = document.querySelector('[data-wall-empty="none"]');

  // 表单字段的原始值（提交给服务端的就是这些）。
  function valueOf(name) {
    var el = form.elements[name];
    return el ? String(el.value || '').trim() : '';
  }

  // 下拉框选中的那句人话（服务端 filterLabels 用的是同一个口径：
  // 武将取「变体+名字」，其余直接拿选项文字）。
  function textOf(name) {
    var el = form.elements[name];
    if (!el || !el.value) return '';
    if (el.tagName === 'SELECT') {
      var opt = el.options[el.selectedIndex];
      return opt ? String(opt.textContent).trim() : '';
    }
    return String(el.value).trim();
  }

  // 和 routes/main.js 的 filterQuery 同一个键序（地址栏和 returnTo 用）。
  function queryString() {
    var p = new URLSearchParams();
    ['hero', 'faction', 'arm', 'tier', 'scored', 'mine', 'q'].forEach(function (k) {
      var v = valueOf(k);
      if (v) p.set(k, v);
    });
    return p.toString();
  }

  // 「筛选：武将 群雄孙坚 · 势力 群（3 / 21 套）」—— 和路由里的 filterNote 一字不差。
  function noteText(shown, total) {
    var parts = [];
    var hero = textOf('hero');
    if (hero) parts.push('武将 ' + hero);
    var faction = valueOf('faction');
    if (faction) parts.push('势力 ' + faction);
    var arm = valueOf('arm');
    if (arm) parts.push('兵种 ' + arm);
    var tier = valueOf('tier');
    if (tier) parts.push('评级 ' + tier);
    var scored = textOf('scored');
    if (scored) parts.push(scored);
    var mine = textOf('mine');
    if (mine) parts.push(mine);
    var q = valueOf('q');
    if (q) parts.push('昵称含「' + q + '」');
    return parts.length ? '筛选：' + parts.join(' · ') + '（' + shown + ' / ' + total + ' 套）' : '';
  }

  // 按当前表单状态收放卡片。updateUrl=false 是页面刚加载时那次：
  // 服务端已经把状态渲染对了，这里只做一次校正（不发生 DOM 变化就什么都不动）。
  function apply(updateUrl) {
    var key = valueOf('hero');
    var shown = 0;
    var changed = false;
    cards.forEach(function (c) {
      var hide = false;
      if (c.hasAttribute('data-rest-hidden')) hide = true;
      else if (key) {
        var heroes = ' ' + (c.getAttribute('data-heroes') || '') + ' ';
        hide = heroes.indexOf(' ' + key + ' ') < 0;
      }
      if (c.classList.contains('is-hidden') !== hide) {
        c.classList.toggle('is-hidden', hide);
        changed = true;
      }
      if (!hide) shown++;
    });

    var qs = queryString();
    var active = !!qs;
    var total = cards.length;

    if (note) {
      var text = active ? noteText(shown, total) : '';
      if (note.textContent !== text) note.textContent = text;
      note.hidden = !text;
    }
    // 空态：一张卡都没有时"没有符合筛选"是句假话，单独给一句。
    if (emptyNone) emptyNone.hidden = total > 0;
    if (emptyFilter) emptyFilter.hidden = !(total > 0 && shown === 0);
    resets.forEach(function (r) { r.hidden = !active; });

    // 打分/评论/纠错的回跳地址跟着当前筛选走（不刷新页面时这些 input 不会自己更新）。
    [].slice.call(grid.querySelectorAll('input[name="returnTo"]')).forEach(function (inp) {
      var v = active ? '/?' + qs : '/';
      if (inp.value !== v) inp.value = v;
    });

    if (updateUrl) {
      try { history.replaceState(null, '', active ? '/?' + qs : '/'); } catch (e) {}
    }
    // 可见集合变了才重新分列 —— 页面刚加载、状态本来就一致时就不闪。
    if (changed && typeof window.ywWallRefresh === 'function') window.ywWallRefresh();
  }

  // 只接管「武将」这一个下拉：用户 2026-10-19 点名要的是它。
  // 其它筛选项仍然走 GET 表单提交（没有 JS 时行为完全一样）。
  heroSel.addEventListener('change', function () { apply(true); });

  // 「清除筛选」不刷新页面：把表单值清空，再按空条件重放一次。
  // ★ 不能调 form.reset()：<option selected> 是服务端渲染的默认值，reset 会把它们放回来。
  resets.forEach(function (reset) {
    reset.addEventListener('click', function (e) {
      e.preventDefault();
      ['hero', 'faction', 'arm', 'tier', 'scored', 'mine', 'q'].forEach(function (name) {
        var el = form.elements[name];
        if (el) el.value = '';
      });
      apply(true);
    });
  });

  apply(false);
})();
