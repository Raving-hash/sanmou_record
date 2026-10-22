/* 阵容纠正：**面板搬进弹窗** + 手输武将的那一层挑选。

   ── 为什么要有这个脚本 ──

   卡片只有 228px 宽（手机 346px），而识别结果那一块要塞下**九个格子**：每格一个标题、
   六七个候选单选框、一个「其他」输入框、一个「不确定」。挤在里面每格只剩 60~70px，
   输入框连 placeholder 都放不下。用户 2026-10-16 晚的口径（分几条消息说的）：

     「改为弹出一个窗口，将输入框放宽不要在列表里面挤压」
     「我希望识别结果如果是待确认的则直接开一个小弹窗进行输入」
     「只给本人弹窗，其他人观看不弹窗也不需要确认」

   于是脚本干两件事：

     ① **把整个纠正面板搬进一个 `<dialog>`**：卡上只留**「编辑阵容」按钮**，
        点它弹窗，九格在窗口里宽宽松松地排（宽屏三列、窄屏一列，见 style.css）。
        **不再进页面就自动弹** —— 见下面 2026-10-17 那条口径。
     ② **手输武将再套一层小弹窗**：那一格的窄 input 藏起来（**值照样提交** —— hidden
        只是不画，不是 disabled），旁边立一个按钮；点它（或者点「其他」那个单选框）弹出
        第二个 `<dialog>`：一整行的输入框 + 按打字实时筛选的名单，点一个就填进去。
        （两层弹窗是叠着的，浏览器原生支持，Esc 先关上面那层。）

   ★ 2026-10-17 用户口径，**「自动弹一次」那条已作废**：

     「按照 ocr 的结果直接确定玩家的阵容，并提供玩家本人一个编辑阵容按钮，
       点击以后跳到现在的待确认界面，不需要自动弹出窗口了」

   所以卡上那一行从「识别结果 · 待核对 N 格」变成**「编辑阵容」按钮**，
   脚本里那段 `data-auto` 自动开窗的逻辑**整个删掉**了。

   ── 打给谁看 ──

   这一整块（按钮 + 面板）**只渲染给能改这张卡的人**：卡主本人和管理员
   （服务端只给他们候选 JSON，见 views/partials/reco.ejs）。游客和别的成员
   **连这一块都没有**，所以谈不上弹窗，也没有"要不要确认"这回事。
   注意**管理员也能改别人的卡**，所以按钮不是"只有卡主看得见"。

   ── 名单从哪来 ──

   就是模板里那份 `<datalist id="reco-hero-names">`（整面墙一份，见 lineup-gallery.ejs）——
   不再引一份数据进来。**这也保证了"挑出来的名字"和"页面上的补全"永远是同一份**。

   ── 边界 ──

   · **没 JS 时一模一样能用**：卡上还是那个原生 `<details>`，点开就地改；单选框 +
     窄输入框 + 原生 datalist 补全，一个字都没少
     （和 lightbox.js / comments.js / report.js 同一个约定：是增强不是依赖）。
     ⚠️ 所以这一层是**把表单搬进弹窗**，不是"在弹窗里另建一份" —— 搬走之后 `<details>`
     里只剩一句摘要，卡的高度一点没变（合着的 details 本来也只画那一行）。
   · **老浏览器没有 `<dialog>`**（Safari < 15.4 之类）→ 探测不到 showModal 就整个退出，
     退回上面那条原路，而不是只做一半。
   · 服务端才是真正的关口：只有能唯一对回库里的名字才写库（见 routes/main.js）。
     弹窗里筛的是库里的名单，所以挑出来的必然过 —— 但**手打的错字仍然由服务端退回**，
     底部那句「库里没有这个名字」只是提前把话说清楚。 */
(function () {
  'use strict';

  // ---------- 探测：没有 <dialog> 就整个不干（见文件头） ----------
  var probe = document.createElement('dialog');
  if (typeof probe.showModal !== 'function') return;

  var panels = [].slice.call(document.querySelectorAll('details.reco-box'));
  if (!panels.length) return;                     // 不是阵容墙，或者这一页没有能改的卡

  // 弹窗开着就把背景滚动锁住（和 lightbox.js 的 .lb-lock 一个道理，只是各用各的类名）。
  // ⚠️ 关的时候要**看还有没有别的弹窗开着**：手输那一层是叠在面板那一层上面的，
  //    关掉上面那层就把锁摘了的话，底下的面板还开着、页面却能滚，看着像坏了。
  function syncLock() {
    document.documentElement.classList.toggle('reco-lock', !!document.querySelector('dialog[open]'));
  }
  // ⚠️⚠️ **`close()` 是同步的，`close` 事件不是** —— 它是排队发的（HTML 规范里
  //   "queue an element task"）。所以"摘滚动锁"和"退单选框"这两件事**必须在关窗那一瞬间
  //   同步做掉**，光挂在 close 事件上的话，关掉之后还有那么一小会儿页面是错的
  //   （锁还挂着、单选框还停在"其他"上）。这里每个自己控制的关法都直接调 syncLock()，
  //   close 事件那条路留着兜 **Esc**（浏览器自己关的，拦不住）。

  // ---------- 一、整个面板搬进弹窗 ----------
  // 一张卡一个弹窗，**第一次点开时才建**（一页十几张卡，没人会去看的那些不必建）。
  function panelFor(box) {
    if (box.__panel) return box.__panel;
    var form = box.querySelector('form');
    var sum = box.querySelector('summary');
    if (!form || !sum) return null;
    var d = document.createElement('dialog');
    d.className = 'reco-dlg is-panel';
    var body = document.createElement('div');
    body.className = 'reco-dlg-body';
    var head = document.createElement('h3');
    head.className = 'reco-dlg-head';
    head.textContent = sum.textContent.replace(/\s+/g, ' ').trim();   // 「编辑阵容」
    body.appendChild(head);
    body.appendChild(form);        // ★ 搬进来 —— 不是另建一份，见文件头那条 ⚠️
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'outline reco-dlg-close';
    close.textContent = '关闭';
    body.appendChild(close);
    d.appendChild(body);
    document.body.appendChild(d);
    var shut = function () { d.close(); syncLock(); };      // 见 syncLock 上面那条 ⚠️⚠️
    close.addEventListener('click', shut);
    d.addEventListener('click', function (e) { if (e.target === d) shut(); });  // 点背景
    d.addEventListener('close', syncLock);                  // Esc 那条路只有这里兜得到
    box.__panel = d;
    return d;
  }

  function openPanel(box) {
    var d = panelFor(box);
    if (!d) return;
    d.showModal();
    syncLock();
  }

  panels.forEach(function (box) {
    var sum = box.querySelector('summary');
    if (!sum) return;
    sum.addEventListener('click', function (e) {
      e.preventDefault();          // 别让它就地展开 —— 展开是**没 JS 时**的退路
      openPanel(box);
    });
  });

  // ★ 这里从前有一段「卡主有待核对就自动弹一次」（读 `data-auto`、多张只弹 id 最大的那张）。
  //   2026-10-17 用户明确不要了：「不需要自动弹出窗口了」—— 模板也不再挂那个标记。
  //   别因为"空着可惜"把它加回来：玩家现在从卡上的「编辑阵容」按钮自己点进来。

  // ---------- 二、手输武将那一层 ----------
  var slots = [].slice.call(document.querySelectorAll('.reco-other'));
  var names = [].slice.call(document.querySelectorAll('#reco-hero-names option'))
    .map(function (o) { return o.value; }).filter(Boolean);
  if (!slots.length || !names.length) return;      // 没有「其他」框，或者没有名单

  // 名单项**建一次、反复用**（102 个，每次开窗重建纯属浪费）；筛选只是切 hidden。
  var items = names.map(function (n) {
    var b = document.createElement('button');
    b.type = 'button';                             // 别当提交按钮：这一层不在表单里，
    b.className = 'reco-dlg-item';                 // 但按钮默认 type 是 submit，写死更稳
    b.textContent = n;
    b.addEventListener('click', function () { pick(n); });
    var li = document.createElement('li');
    li.appendChild(b);
    return li;
  });

  var dlg = document.createElement('dialog');
  dlg.className = 'reco-dlg';
  dlg.innerHTML = '<div class="reco-dlg-body">'
    + '<h3 class="reco-dlg-head"></h3>'
    + '<p class="reco-dlg-tip">只能选武将库里的名字 —— 库里没有的存不进去。</p>'
    + '<input class="reco-dlg-input" type="text" autocomplete="off" spellcheck="false"'
    + ' placeholder="打几个字，从下面挑">'
    + '<ul class="reco-dlg-list"></ul>'
    + '<p class="reco-dlg-empty" hidden>库里没有这个名字，换个写法试试（或者从名单里挑一个）。</p>'
    // 取消用 outline 那档（Pico）—— 和站里别处的次要按钮一个样子。这里是唯一的按钮，
    // 画成主色金的话它看着像"这一窗的正事"，而正事明明是挑名字。
    + '<div class="reco-dlg-foot"><button type="button" class="outline reco-dlg-cancel">取消</button></div>'
    + '</div>';
  var head = dlg.querySelector('.reco-dlg-head');
  var input = dlg.querySelector('.reco-dlg-input');
  var list = dlg.querySelector('.reco-dlg-list');
  var empty = dlg.querySelector('.reco-dlg-empty');
  items.forEach(function (li) { list.appendChild(li); });
  document.body.appendChild(dlg);

  var cur = null;        // 这一窗是在给哪一格挑：{ box, btn, radio, back }

  function filter() {
    var q = input.value.trim().toLowerCase();
    var shown = 0;
    items.forEach(function (li) {
      var hit = !q || li.textContent.toLowerCase().indexOf(q) >= 0;
      li.hidden = !hit;
      if (hit) shown++;
    });
    empty.hidden = shown > 0;
    list.scrollTop = 0;                            // 筛完回到顶上，否则停在上一轮的位置
  }

  // 关窗的唯一出口（挑中 / 取消 / 点背景都走它）—— 见 syncLock 上面那条 ⚠️⚠️：
  // 退单选框和摘锁都在这儿**同步**做掉，不指望 close 事件（它是排队发的）。
  function shut() {
    if (cur && !cur.picked && !cur.box.value && cur.back) cur.back.checked = true;
    cur = null;
    dlg.close();
    syncLock();
  }

  function pick(name) {
    cur.box.value = name;                          // 真正的值写进**原来那个 input**
    cur.radio.checked = true;                      // 服务端只在「其他」被勾中时才读它
    cur.btn.textContent = name;
    cur.btn.classList.add('is-set');
    cur.picked = true;
    shut();
  }

  function open(box, btn, radio) {
    cur = {
      box: box, btn: btn, radio: radio, picked: false,
      // 开窗之前是哪个单选框勾着的：取消时**退回它**。
      // 不退的话，玩家点了「其他」又反悔，那一格就停在"其他 + 空框"上 —— 提交上去
      // 等于没动（服务端见空文本直接跳过），看着像是点了没反应。
      back: box.form ? box.form.querySelector('input[name="' + box.name.replace('other', 'slot') + '"]:checked') : null,
    };
    head.textContent = (btn.getAttribute('data-where') || '这一格') + '：手输武将名';
    input.value = box.value || '';
    filter();
    dlg.showModal();
    syncLock();
    input.focus();
    input.select();
  }

  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) shut();                  // 点背景关掉（.reco-dlg 没有内边距，
  });                                              // 所以命中的一定是背景，见 style.css）

  input.addEventListener('input', filter);
  input.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    var first = items.filter(function (li) { return !li.hidden; })[0];
    if (first) first.querySelector('button').click();   // 回车 = 挑第一个命中的
  });
  dlg.querySelector('.reco-dlg-cancel').addEventListener('click', shut);

  // Esc 兜底：浏览器自己把窗关掉，拦不住，只能在 close 事件里补一遍同样的事
  // （自己控制的三种关法都已经在 shut() 里同步做完了，走到这儿时 cur 已经是 null）。
  dlg.addEventListener('close', function () {
    if (cur && !cur.picked && !cur.box.value && cur.back) cur.back.checked = true;
    cur = null;
    syncLock();
  });

  slots.forEach(function (box) {
    var slot = box.closest ? box.closest('.reco-slot') : null;
    if (!slot) return;
    var radio = slot.querySelector('input[type=radio][value="__other__"]');
    if (!radio) return;

    // ① 窄输入框让位给按钮。**不是 disabled**，所以 value 照样跟着表单提交。
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'reco-pick';
    // 按钮上的字就是**那个文本框的内容**（空的时候是句提示），选的到底是哪一项由上面
    // 那个单选框说了算 —— 和从前那个窄输入框一模一样：点了候选之后框里的字也还在。
    // **别顺手把它做成"选中才显示"**：那会让"我先打了字、又改点了候选"这种来回变得
    // 没法退出（字一消失就得重新打一遍）。
    btn.textContent = box.value || '手输 / 挑选…';
    if (box.value) btn.classList.add('is-set');
    // 弹窗标题上要写清是哪一格 —— 九格长得一模一样，只写「手输武将名」会不知道在改哪儿。
    var k = slot.querySelector('.reco-slot-k');
    btn.setAttribute('data-where', k ? k.textContent.replace(/\s+/g, ' ').trim() : '');
    box.hidden = true;
    box.insertAdjacentElement('beforebegin', btn);

    btn.addEventListener('click', function () { open(box, btn, radio); });
    // 勾「其他」也开窗：勾它本来就是为了手输，没有第二个理由。
    // （`change` 只在它**变成**选中时来，所以点一个已经勾着的「其他」不会再弹一次 ——
    //   那种情况点旁边的按钮，按钮一直在。）
    radio.addEventListener('change', function () { if (radio.checked) open(box, btn, radio); });
    // 值被别处改掉时（只可能是没走弹窗那条路：脚本更早的版本、或者将来别的入口）
    // 也把「其他」勾上 —— 不然那个值提交不上去（服务端只在「其他」被勾中时读它）。
    box.addEventListener('input', function () { if (box.value) radio.checked = true; });
  });
})();
