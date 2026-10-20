/* 阵容墙的版面（views/partials/lineup-gallery.ejs 那面墙）。干两件事：
 *
 *   一、**一列一列往下排**（而不是 grid 那样一排排往下排）。
 *       为什么：grid 的"行高"是同一排共享的 —— 任何一张卡变高（最常发生的就是点开
 *       评论区），整排、乃至下面每一排都会被顶下去，正在看的卡片当场跳走。
 *       拆成 N 个独立的竖列之后，撑开一张卡只顶自己那一列。
 *       **顺序不变**：按 i % N 分列，第一列装第 1、N+1、2N+1… 张，读起来仍然是
 *       "从左往右、满一行换一行"（纯 CSS 的 columns 会把顺序变成竖着念，所以没用它）。
 *
 *   二、**同一排逐块对齐**（用户 2026-10-14 的要求："每一行的文字都在一个水平线上"）。
 *       卡里的顶栏会因昵称长短折成 1~3 行、打分区会因为"你打了 X / 点别的档位就是改分"
 *       那两行变高，于是同一排的图框、说明、均分/最高/最低、💬 全都错开。这里按**排**
 *       把每一块的最大高度量出来、写成 min-height，让同一排的这些块一样高。
 *
 * 是增强不是依赖：脚本没跑（关 JS、加载失败）时 `.is-cols` 不生效，版面退回 grid 的样子
 * —— 功能一样都不少，只是点开评论区会把整排顶下去。同理，卡片少于 2 张时直接不动。
 *
 * ⚠️ 必须在 public/comments.js **之前**引（见 views/partials/footer.ejs）：这个脚本量的是
 * 布局，而 comments.js 会按 #e<id> 把某张卡的评论区展开。反过来先展开再量的话，那张卡的
 * 高度会被算进"这一排该多高"，用户把评论收起来之后整排还是被撑着。
 * （resize 那条路径上躲不开，所以在 align() 里量之前会先把展开的合上、量完再还原。）
 *
 * 2026-10-19 加了一条"外部可以喊我重排"的路：首页换武将（public/home-filter.js）
 * 会收放卡片（.is-hidden），然后调 window.ywWallRefresh() —— 这里就重新现取可见卡、
 * 重新分列、重新对齐。分列会打乱 DOM 顺序，所以"原顺序"靠卡片上的 data-seq 记着。
 */
(function () {
  'use strict';

  // 每一排要比着量的三块（顺序就是卡片里的顺序）。图框是写死高度的、评论行只有一行字，
  // 都不用管。
  var HEAD = '.shot-head';     // 顶栏：折行数随昵称长短变
  var NOTE = '.shot-note';     // 说明：写了几行就几行（没写的是一格空的，见模板）
  var RATE = '.shot-rate';     // 打分区：有没有"你打了 X"那两行决定高矮
  // 阵容识别那一块（2026-10-16 加）：有识别结果的卡比没有的高 89px。
  // ★ 它必须跟上面三块一起撑 —— 这一块是**卡片里最后一块高度可变的**，
  //   不撑的话富余会跑到它下面去，同一排的评论行整排错开（实测差 89px）。
  //   模板那边配合着**无条件渲染**这个盒子（没有识别结果时是个空 div），
  //   所以这里 9 张卡里一张有、八张没有的情况也能撑齐。见 views/partials/reco.ejs 的头注释。
  var RECO = '.reco';

  var box = function (el) { return el ? el.getBoundingClientRect().height : 0; };

  // 给一面墙建一个控制器。**总是**返回一个（哪怕现在只剩 0/1 张可见卡）：
  // 首页换武将（public/home-filter.js）会随时收放卡片，控制器得一直在。
  function columns(grid) {
    var cols = 1;        // 当前列数（align 分组要用）
    var key = '';        // 上一次重建时的判据，见 build()
    var cards = [];      // **当前可见**的卡（.is-hidden 的不算），按原顺序

    // 现取所有卡（含藏起来的），按**最初**的顺序排好。
    // 为什么不能直接用 DOM 顺序：分列之后卡片被搬进了 .shot-col，DOM 顺序变成
    // "一列一列"的（第 1 列整列、再第 2 列整列…），跟排名顺序对不上。
    // 第一次见面时把序号写进 data-seq，以后都按它排。
    function collect() {
      var all = [].slice.call(grid.querySelectorAll('.shot-card'));
      all.forEach(function (c, i) {
        if (!c.hasAttribute('data-seq')) c.setAttribute('data-seq', String(i));
      });
      all.sort(function (a, b) {
        return Number(a.getAttribute('data-seq')) - Number(b.getAttribute('data-seq'));
      });
      return all;
    }
    function visible(c) { return !c.classList.contains('is-hidden'); }

    // 把**所有**卡平铺回 grid（隐藏的也要留在 DOM 里 —— 换个筛选还得放出来），
    // 顺手拆掉上一轮的 .shot-col 外壳。
    function flatten(all) {
      all.forEach(function (c) { grid.appendChild(c); });   // appendChild 会把卡从旧列里搬走
      [].slice.call(grid.children).forEach(function (el) {
        if (!el.classList || !el.classList.contains('shot-card')) grid.removeChild(el);
      });
    }

    // 分列。列数变了、或者卡宽变了才真的重建。
    function build() {
      var all = collect();
      cards = all.filter(visible);

      if (!cards.length) {
        // 一张可见的都没有：清掉旧列（否则空列还会占着列间距），别的什么都不用做。
        flatten(all);
        grid.classList.add('is-cols');
        cols = 0;
        key = '';
        return;
      }

      var cardW = cards[0].getBoundingClientRect().width;
      var cs = getComputedStyle(grid);
      var gap = parseFloat(cs.columnGap);            // 桌面 .75rem，窄屏同一档
      if (isNaN(gap)) gap = parseFloat(cs.gap) || 0;
      // 和 CSS 里 repeat(auto-fill, 200px) 同一个算法：容器宽度里放得下几张
      var fit = Math.floor((grid.clientWidth + gap) / (cardW + gap));
      var next = Math.max(1, Math.min(fit, cards.length));

      // ★ 判据要**带上卡宽**：640px 那个断点把卡从 200px 变成 150px，而列数可能没变
      //   （只比列数的话，按 200px 算出来的 min-height 会留着，窄屏顶栏多折一行之后就全歪了）。
      var k = next + '@' + Math.round(cardW);
      if (k === key) return;
      key = k;
      cols = next;

      // 搬 DOM 之前记下哪些评论区是开着的。浏览器一般会保住 <details> 的 open
      // （它是元素上的属性，不随位置走），但这是个"一般"，不值得赌。
      var opened = cards.filter(function (c) {
        var b = c.querySelector('details.cmt');
        return b && b.open;
      }).map(function (c) { return c.id; });

      // 先平铺（含隐藏卡），再只把可见卡轮流放进新列：
      // 第 i 张进第 i % cols 列 —— 视觉上仍是"从左往右、满行换行"。
      flatten(all);
      var col = [];
      for (var i = 0; i < cols; i++) col.push(document.createElement('div'));
      cards.forEach(function (c, i) { col[i % cols].appendChild(c); });
      col.forEach(function (d) {
        d.className = 'shot-col';
        grid.appendChild(d);
      });
      grid.classList.add('is-cols');                 // 样式表里靠它把 grid 换成 flex

      opened.forEach(function (id) {
        var c = id && document.getElementById(id);
        var b = c && c.querySelector('details.cmt');
        if (b) b.open = true;
      });
    }

    // 逐排对齐。**排 = 分列前的第 floor(i / cols) 组**：
    // i % cols 是"列"（同一列的卡竖着码在一起），别拿它当排。
    function align() {
      // 上一轮的 min-height 必须先清掉，否则量出来的是上一轮的结果
      cards.forEach(function (c) {
        c.style.minHeight = '';
        [HEAD, NOTE, RATE, RECO].forEach(function (sel) {
          var e = c.querySelector(sel);
          if (e) e.style.minHeight = '';
        });
      });

      // 量之前先把展开的评论区合上：开着的那张会把卡片撑高，写进 min-height 之后
      // 用户收起评论，整排还是被撑着。（合上是同步的，量完立刻还原，用户看不见。）
      var opened = [].slice.call(grid.querySelectorAll('details.cmt[open]'));
      opened.forEach(function (b) { b.open = false; });

      var rows = [];
      cards.forEach(function (c, i) {
        var r = Math.floor(i / cols);
        (rows[r] = rows[r] || []).push(c);
      });

      rows.forEach(function (row) {
        // ① 顶栏、说明、打分区各自等高。三块一样高 + 图框写死 + 评论行只有一行 ⇒
        //    这一排的卡片自然就一样高，图框、说明首行、均分那三行、按钮行、💬 全落在
        //    同一条水平线上。
        //    ★ 说明这一块**必须一起撑**，不能只撑顶栏和打分区、指望卡片本身的高度去兜：
        //    那样富余的高度会落到打分区上方的 margin-top:auto 里，用户一点开评论区，
        //    这点富余先被吃掉 —— 按钮整排往上跳 100px，然后卡片才开始往下长。
        //    三块都撑齐之后富余为 0，展开评论区就是干干净净地往下长。
        [HEAD, NOTE, RATE, RECO].forEach(function (sel) {
          var els = [];
          row.forEach(function (c) {
            var e = c.querySelector(sel);
            if (e) els.push(e);
          });
          var max = 0;
          els.forEach(function (e) { max = Math.max(max, box(e)); });
          els.forEach(function (e) { e.style.minHeight = Math.ceil(max) + 'px'; });
        });

        // ② 卡片本身再兜一道底：万一还有哪一块没考虑到（模板后来加了东西），
        //    同排也照样等高。三块都齐的时候这一步算出来的就是它们各自的高度，不产生富余。
        var tallest = 0;
        row.forEach(function (c) { tallest = Math.max(tallest, box(c)); });
        row.forEach(function (c) { c.style.minHeight = Math.ceil(tallest) + 'px'; });
      });

      opened.forEach(function (b) { b.open = true; });
    }

    // 筛选收放了卡片之后喊这个：可见集合可能变了，判据得作废、必须重建。
    // 和 resize 那条路的区别就在这儿 —— 那边卡宽没变就可以原地不动。
    function refresh() {
      key = '';
      build();
      align();
    }

    return { build: build, align: align, refresh: refresh };
  }

  var walls = [];
  [].slice.call(document.querySelectorAll('.shot-grid')).forEach(function (grid) {
    var api = columns(grid);
    api.build();
    api.align();
    walls.push(api);
  });

  // 首页换武将（public/home-filter.js）收放完卡片会喊一声。
  // **无条件挂着**：别的页面没人喊它，多一个函数不会花任何代价。
  window.ywWallRefresh = function () {
    walls.forEach(function (w) { w.refresh(); });
  };

  // 窗口变了就重来一遍：列数、卡宽都可能跟着断点变。build() 自己判断要不要重建 DOM，
  // align() 每次都跑（便宜，而且量的是当下的真实布局）。
  var timer = 0;
  window.addEventListener('resize', function () {
    clearTimeout(timer);
    timer = setTimeout(function () {
      walls.forEach(function (w) { w.build(); w.align(); });
    }, 150);
  });
})();
