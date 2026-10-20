/* 首页阵容墙筛选：**不刷新页面**，选完直接收放卡片（2026-10-19 用户要求）。
 *
 * 为什么这么做：筛选从前是一张纯 GET 表单，选完点「筛选」整页重排 —— 页面要重下、
 * 重画一遍，还会跳回页顶。武将名单有 102 个，玩家在首页挨个点过去时这一下很烦。
 *
 * 数据从哪来：服务端把**全部**卡片都渲染出来（routes/main.js 的 visibleIds），
 * 不匹配当前筛选的卡片挂 .is-hidden（CSS 里就是 display:none）。卡片上还带着
 * 筛选要用的 data-*（见 views/partials/lineup-gallery.ejs）：
 *   data-heroes    第一张图里的武将 key（空格分隔）
 *   data-factions  这些武将的势力
 *   data-arms      这些武将的兵种
 *   data-tier      搭配评级（没认出武将时是 T3，和 db.lineupTier([]) 一致）
 *   data-scored    交了积分没有（1 / 0）
 *   data-rated     我打过这一套的分没有（1 / 0）
 *   data-nick      昵称（按子串匹配，大小写不敏感）
 * 于是这里可以**完全在本地**重算一张卡该不该露出来，和服务端 filterWall 同一套口径：
 *   · 没有 JS：服务端已经按同样的条件挂好了 .is-hidden，GET 表单提交后看到的一模一样；
 *   · 有 JS：选任何一项都不再提交表单，只改 class，所以不会刷新、也不会跳回页顶。
 *
 * 还有三件容易漏的事：
 *   ① 打分/评论/纠错表单里的 hidden returnTo 是**服务端渲染那一刻**的地址。不刷新页面时
 *      它就过期了 —— 投完票会跳回旧筛选。所以这里每次筛选都把 .shot-grid 里的
 *      returnTo 改写成当前地址。
 *   ② public/wall.js 已经把墙拆成 .shot-col 竖列了，藏掉几张卡之后必须让它重新分列、
 *      重新对齐，否则那几列里会留下空洞。这里改完喊一声 window.ywWallRefresh()。
 *   ③ 表单的 submit 也要拦：用户习惯选完点「筛选」（或者在昵称框里按回车），
 *      不拦的话照样整页刷新 —— 那正是 2026-10-19 用户报的"还是在刷新、还跳到页顶"。
 *      现在按钮留着只是为了没有 JS 时还能用，有 JS 时它等于"再应用一次"。
 *
 * 没 JS / 不是首页：第一行就退出，不影响任何页面。
 */
(function () {
  'use strict';

  var form = document.querySelector('form.wall-filter');
  if (!form) return;
  var grid = document.querySelector('.shot-grid');
  if (!grid) return;

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

  // data-heroes / data-factions / data-arms 都是空格分隔的一串 key，按词匹配
  // （不能直接 indexOf：`sun_jian` 会误命中 `sun_jian2`）。
  function inList(card, attr, value) {
    return (' ' + (card.getAttribute(attr) || '') + ' ').indexOf(' ' + value + ' ') >= 0;
  }

  // 和服务端 routes/main.js 的 filterWall 一一对应（改那边记得改这里）。
  function hiddenBy(card, f) {
    if (f.hero && !inList(card, 'data-heroes', f.hero)) return true;
    if (f.faction && !inList(card, 'data-factions', f.faction)) return true;
    if (f.arm && !inList(card, 'data-arms', f.arm)) return true;
    if (f.tier && card.getAttribute('data-tier') !== f.tier) return true;
    if (f.scored && card.getAttribute('data-scored') !== f.scored) return true;
    if (f.mine) {
      var rated = card.getAttribute('data-rated') === '1';
      if (f.mine === 'rated' ? !rated : rated) return true;
    }
    if (f.q && String(card.getAttribute('data-nick') || '').toLowerCase().indexOf(f.q) < 0) return true;
    return false;
  }

  // 按当前表单状态收放卡片。updateUrl=false 是页面刚加载时那次：
  // 服务端已经把状态渲染对了，这里只做一次校正（不发生 DOM 变化就什么都不动）。
  function apply(updateUrl) {
    var f = {
      hero: valueOf('hero'),
      faction: valueOf('faction'),
      arm: valueOf('arm'),
      tier: valueOf('tier'),
      scored: valueOf('scored'),
      mine: valueOf('mine'),
      q: valueOf('q').toLowerCase(),
    };
    var shown = 0;
    var changed = false;
    cards.forEach(function (c) {
      var hide = hiddenBy(c, f);
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

  // 下拉框一改就应用（武将、势力、兵种、评级、积分、我的打分都算）。
  ['hero', 'faction', 'arm', 'tier', 'scored', 'mine'].forEach(function (name) {
    var el = form.elements[name];
    if (el) el.addEventListener('change', function () { apply(true); });
  });

  // ★ 拦截提交：点「筛选」或在昵称框按回车都**不再整页刷新**。
  // 这正是 2026-10-19 用户报的那一下 —— 只挂 change 不够，用户还是会去点按钮。
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    apply(true);
  });

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
