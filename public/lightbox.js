/* ==========================================================================
   点图看大图：在页面里盖一层弹层，不再跳新标签页
   （手机浏览器里跳走一次就得按返回，很容易把看到一半的阵容弄丢）。

   判据是 href + DOM，模板上不用挂类名：任何 <a> 只要 href 以**图片域名**开头、
   里面又装了 <img>，点它就开弹层。全站十几处图片链接因此一行都不用改。

   ★ 2026-10-15 起图片在 Cloudflare R2 上，href 是**跨域的绝对地址**，
     不再是站内的 /uploads/…。域名从 <html data-img-base>（由
     views/partials/header.ejs 渲染）读，静态文件里不硬编码 —— 换域名只改 .env 一处。
     **保留 /uploads/ 兜底**：用户手上可能还有缓存的旧 HTML（nginx 给 /public/ 盖了
     max-age=604800），那些页面里的链接还是老形状。老形状由 routes/uploads.js
     的 302 送到 R2，图照样能显示。

   ★ 这是**增强**，不是依赖：脚本没加载、浏览器太老、JS 被关了，模板里那个
     <a target="_blank" rel="noopener"> 照旧把原图开在新标签页 —— 也就是今天的样子。
     弹层的 DOM 全部在这里现建：没有 JS 的页面上不该多出一个永远打不开的空壳
     （和 upload.js 里「虚线框由 JS 生成」同一个理由）。

   给模板留的钩子只有一个：data-shots="url1 url2 …"
     写在图片链接上，表示这几张是一组（同一个人的全部阵容截图）。
     有了它，弹层会多出 ‹ › 两个按钮、支持 ← → 键，说明里带「2/3」；
     不写就是单张，没有翻页按钮，也没有键盘左右。

     阵容墙每张卡只摊开第一张图（见 views/partials/lineup-gallery.ejs），
     另外几张就在这一组里 —— 有翻页才真能看见，不用再专门跑一趟 /lineup。
     卡面上**没有**任何"这人还有几张"的文字（顶栏那枚「共 N 张」2026-10-14 去掉了，
     用户的口径是：反正卡上只出第一张）。多图这件事只剩打开之后的「2/3」那句。

   几个刻意的取舍：
   - 点哪都能关（包括点图本身），手机上最省事；只有 ‹ › 和右上角那个 × 例外。
   - 中键 / Ctrl / ⌘ / Shift 点击一律不拦：那些是用户明说要交给浏览器自己处理
     （新标签页、新窗口、下载），拦下来只会让人以为"图打不开"。
   - 不写历史记录（不推 hash）：关掉就回到原样，后退键不会把人卡在弹层里。
   ========================================================================== */
(function () {
  'use strict';

  var PREFIX = document.documentElement.getAttribute('data-img-base') || '/uploads/';
  var HINT = '点任意处或按 Esc 关闭';
  var HINT_NAV = ' · 方向键 ← → 翻页';

  var box = null;                  // 弹层根节点：第一次点图才建（见文件头）
  var imgEl, mainEl, hintEl, prevEl, nextEl;
  var group = [];                  // 当前这一组图的 href
  var at = 0;                      // 正在看第几张
  var startAt = 0;                 // 点开时落在第几张（见 render 里的缩略图占位）
  var thumbSrc = '';               // 点开的那一张在页面上显示着的缩略图（已进缓存）
  var capBase = '';                // 说明的固定部分（img 的 alt）
  var opener = null;               // 是哪个 <a> 打开的，关掉时把焦点还给它

  function make(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  // ‹ › × 这几个符号直接用字符写，不引图标字体、不写 SVG（全站就这么两个按钮）。
  // aria-label 是给读屏软件的：那几个符号它念不出来。
  function button(cls, text, label) {
    var b = make('button', 'lb-btn ' + cls, text);
    b.type = 'button';               // 不写就是 submit，万一将来被塞进表单里会误提交
    b.setAttribute('aria-label', label);
    return b;
  }

  function build() {
    box = make('div', 'lightbox');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', '图片预览');
    box.tabIndex = -1;               // 打开时把焦点收进来，键盘用户的位置才是确定的

    var fig = make('figure', 'lb-fig');
    imgEl = make('img', 'lb-img');
    imgEl.alt = '';                  // 说明在下面的 figcaption 里，同一个昵称不必念两遍
    var cap = make('figcaption', 'lb-cap');
    mainEl = make('span', 'lb-cap-main');
    hintEl = make('span', 'lb-hint');
    cap.appendChild(mainEl);
    cap.appendChild(hintEl);
    fig.appendChild(imgEl);
    fig.appendChild(cap);

    prevEl = button('lb-prev', '‹', '上一张');
    nextEl = button('lb-next', '›', '下一张');

    box.appendChild(fig);
    box.appendChild(button('lb-x', '×', '关闭'));
    box.appendChild(prevEl);
    box.appendChild(nextEl);

    // 点哪都能关，只有 ‹ › 例外。监听挂在这一层上，点了别处也照样收场。
    box.addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('.lb-btn') : null;
      if (b === prevEl) return step(-1);
      if (b === nextEl) return step(1);
      close();
    });

    // 图打不开（多半是刚被删掉）时别只留一个破图标，说一句人话
    imgEl.addEventListener('error', function () {
      if (box.classList.contains('is-on')) {
        mainEl.textContent = '这张图打不开了，可能刚被删掉 —— 刷新页面再看看。';
      }
    });

    document.body.appendChild(box);
  }

  // <a> 上的 data-shots 拆成一组 href；没写就是单张。
  // href 那张必须在组里：模板写漏了（比如 data-shots 拼错）也得能看见自己点的那张。
  function groupOf(a) {
    var href = a.getAttribute('href');
    var list = String(a.getAttribute('data-shots') || '').split(/\s+/).filter(Boolean);
    if (list.indexOf(href) < 0) list.unshift(href);
    return list;
  }

  function render() {
    var full = group[at];
    // 页面上那一格放的是**缩略图**（约 25KB，早就在本地了），点开要看的却是原图
    // （约 350KB，走隧道两三秒）。这两三秒里弹层不该是一片空白：先把已经在本地的缩略图
    // 顶上去，原图下完再换。只有"点开的这一张"手边有缩略图，‹ › 翻到的其它张照旧直接加载。
    var ph = at === startAt ? thumbSrc : '';
    imgEl.src = ph || full;
    if (ph) {
      var pre = new Image();
      pre.onload = function () {
        // 等原图这几秒里人可能已经翻走、或者关掉又点了别的 —— 只换还在看的那一张
        if (box.classList.contains('is-on') && group[at] === full) imgEl.src = full;
      };
      pre.onerror = function () { imgEl.src = full; };   // 原图真没了，交给下面 imgEl 的 error 说话
      pre.src = full;
    }
    // 说明 = alt（模板里已经带了昵称）+ 组内序号。用 textContent 拼，绝不用 innerHTML：
    // alt 里是用户自己起的昵称，拼进 HTML 就不是文本了。
    mainEl.textContent = capBase + (group.length > 1 ? `（${at + 1}/${group.length}）` : '');
  }

  function step(d) {
    at = (at + d + group.length) % group.length;   // 首尾相接，到头了转一圈回去
    render();
  }

  function open(a) {
    if (!box) build();
    group = groupOf(a);
    at = Math.max(0, group.indexOf(a.getAttribute('href')));
    var im = a.querySelector('img');
    capBase = (im && im.alt) || '';
    startAt = at;                                             // 见 render()：这一张手边有缩略图
    thumbSrc = (im && im.getAttribute('src')) || '';
    opener = a;

    box.classList.toggle('is-solo', group.length < 2);
    hintEl.textContent = HINT + (group.length > 1 ? HINT_NAV : '');
    render();

    box.classList.add('is-on');
    document.documentElement.classList.add('lb-lock');   // 锁住背景滚动
    box.focus();
  }

  function close() {
    if (!box || !box.classList.contains('is-on')) return;
    box.classList.remove('is-on');
    document.documentElement.classList.remove('lb-lock');
    // 焦点还给点图的那个链接：键盘用户关掉之后 Tab 从原地接着走，不会掉回页面开头
    if (opener && opener.focus) opener.focus();
    opener = null;
  }

  document.addEventListener('keydown', function (e) {
    if (!box || !box.classList.contains('is-on')) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowLeft' && group.length > 1) { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight' && group.length > 1) { e.preventDefault(); step(1); }
  });

  // 拦点击。挂在 document 上（委托），所以后加的图链接一样管用。
  document.addEventListener('click', function (e) {
    // defaultPrevented：这一下已经被别的脚本处理过了，别抢
    // button !== 0 / 带修饰键：中键、Ctrl、⌘、Shift —— 用户明说了要用浏览器自己的方式打开
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

    var a = e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !a.querySelector('img')) return;                    // 只管"里面装了图的链接"
    // 用 getAttribute（拿到**原样写在模板里**的那个字符串）而不是 a.href。
    // 从前这是必需的：模板写的是站内相对路径 /uploads/x.jpg，a.href 会被解析成
    // 绝对 URL 就比不上了。现在 href 本身就是绝对的，两者等价 ——
    // 但仍然留着 getAttribute：顺带躲开浏览器对 URL 的归一化
    // （百分号编码的大小写、空路径段之类），免得又冒出一个"偶尔比不中"。
    if (String(a.getAttribute('href')).indexOf(PREFIX) !== 0) return;

    e.preventDefault();      // ← 就这一下拦掉新标签页；模板里的 target 留着给没 JS 的情况
    open(a);
  });
})();
