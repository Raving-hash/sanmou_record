/* ==========================================================================
   上传页的两半。**它俩现在的关系变了，别再按从前那句话去理解**：

     从前：两半都是"增强"—— 脚本没加载、浏览器太老、JS 被关了，点选提交一切照旧。
     现在：**没有 JS 就传不了图**。图片由浏览器直传 Cloudflare R2，服务端不再经手
           字节，所以"用原生表单把文件 POST 给服务器"这条路已经不存在了。
           这是本次改造的**已知功能降级**，页面上用 <noscript> 明说了（见 views/lineup.ejs）。
           拖拽那半（第二节）仍然是纯增强，降级行为一个字没变。

   第一节、提交前：压缩 → 签名 → 直传 R2
     走的顺序是**先全压完 → 再要令牌 → 再统一 PUT**，三个理由：
       · 压完才知道有没有解不开的图，失败时**一个对象都不会产生**（不产生孤儿）；
       · 令牌有 10 分钟有效期，先签名再慢慢压会把有效期吃掉；
       · 拿令牌的接口会顺便做**配额预检**（赛期在不在、阵容额度够不够），
         放在压完之后调，就不会白压白传一批注定被拒的图。

     为什么必须在浏览器里压：手机原图 3~5MB，六张 20MB+。不过现在压的理由变了 ——
     从前是"挤那条很细的隧道"，现在是"R2 的存储和流量虽然是钱但也是配额，
     而且大图在阵容墙上打开很慢"。上传路径本身不再经过家里的宽带了。

     ★方向：手机竖拍照片的方向记在 EXIF 里，canvas 重编码会把 EXIF 丢掉。
     所以这里用 <img> 解码 —— 现代浏览器渲染 <img> 时默认就按 EXIF 摆正
     （image-orientation 默认值 from-image），drawImage 拿到的已经是摆正的位图。

   ★它**不是**防"猜 UUID"：站上所有阵容图 URL 都是公开的（游客可见的阵容墙上就渲染着），
     别人的 key 是公开信息。它防的是"甲拿乙的 key 提交进自己的阵容、再删掉那一行，
     把乙的图删掉" —— 详见 upload.js 里那段注释。

   第二节、拖拽（仅桌面）/ 粘贴（两样设备都行）
     做法：把拖进来的文件、或剪贴板里的图片，灌进那个**原生** <input type="file">。
     （灌得进去是因为 input.files 允许赋一个 DataTransfer 的 FileList。）

     粘贴是 2026-10-19 加的：截图之后直接 Ctrl+V / ⌘V，不用先存成文件再点选。
     **只接管"剪贴板里真的有文件"的粘贴** —— 贴文字（阵容说明那个文本框）
     一点都不能碰，所以判据是先取文件、取不到就原样放行。

     给模板留的钩子：
       form[data-upload-kind]        lineup / score，决定要令牌时的用途
       form[data-key-field]          提交时用哪个字段名承载令牌（images / image_key）
       form[data-upload-max-bytes]   单张压完后的上限，服务端渲染进来（唯一真源在服务端）
       input[multiple]               有 = 能拖多张；没有 = 只留第一张
       input[data-max="N"]           还能再选几张（阵容墙的剩余额度，见 views/lineup.ejs）
       ★ 文件 input **没有 name** —— 这是"字节不再经手服务端"的**结构性保证**：
         没有名字，浏览器就不会把文件放进表单里去。不是靠 input.value='' 之类的技巧。
   ========================================================================== */
(function () {
  'use strict';

  var MB = 1024 * 1024;

  function bytes(n) {
    return n >= MB ? (n / MB).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // 能不能把 DataTransfer 的文件灌进原生 input？**只有拖拽那半靠它**了 ——
  // 上传那半现在是"读出 input.files 直接 PUT"，用不着往回灌。
  // 探针用一个**真的** input 去赋值，而不是查 API 表：Safari < 14.1、Firefox < 62
  // 是赋值时才抛，光看 prototype 上有没有 files 看不出来。
  function canAssignFiles() {
    try {
      var el = document.createElement('input');
      el.type = 'file';
      el.files = new DataTransfer().files;
      return true;
    } catch (e) {
      return false;
    }
  }

  /* ==========================================================================
     一、压缩 → 签名 → 直传
     这一半要 Promise / canvas / fetch，进不了老浏览器，所以用现代语法写，
     不跟着下面那半用 var + function 绕。
     ========================================================================== */

  var MAX_EDGE = 2560;              // 长边上限。截图里的字要看得清，别缩太狠
  var THUMB_EDGE = 640;             // 缩略图长边。页面上最大的显示位是 .thumb-lg 320px
  var THUMB_Q = 0.72;               // 缩略图质量（和服务端时代的 640/q72 对齐）

  // 大图的压缩阶梯：[长边, 质量]，从上往下试，第一个压进上限的就用。
  // 第一档不缩尺寸（withoutEnlargement 等价于原样），因为只重编码往往就够了 ——
  // 实测 2844×1280 的游戏截图原尺寸 q85 只有约 300KB，没必要为体积去动人家的像素。
  // 真正压不动的（大面积噪点的照片）才逐档降尺寸。
  var LADDER = [
    [2560, 0.85], [2560, 0.72],
    [1920, 0.75], [1600, 0.70],
    [1280, 0.65], [1024, 0.60],
  ];

  var COMPRESSIBLE = /^image\/(jpeg|png|webp)$/;

  var toBlob = (cv, q) => new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', q));

  // 解码成位图。走 <img> 是为了稳妥地拿到「已按 EXIF 摆正」的那一份（见文件头）
  function decode(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve({
        img,
        w: img.naturalWidth || img.width,
        h: img.naturalHeight || img.height,
        release: () => URL.revokeObjectURL(url),
      });
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('读不出这张图（可能不是图片或已损坏）')); };
      img.src = url;
    });
  }

  // 按长边 edge 画到 canvas 上（不放大）。png 的透明区填白底 —— 和服务端时代
  // sharp 的 flatten({background:'#ffffff'}) 保持一致，不然透明处会变黑。
  function scaleCanvas(img, w, h, edge) {
    const scale = Math.min(1, edge / Math.max(w, h));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const cv = document.createElement('canvas');
    cv.width = cw;
    cv.height = ch;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(img, 0, 0, cw, ch);
    return cv;
  }

  // 走阶梯，返回第一个 <= MAX_BYTES 的 Blob；都压不下去返回 null。
  // 同一档长边只画一次（阶梯里 2560 出现两次，只换质量）
  async function ladderToFit(d, maxBytes) {
    let cv = null, cvEdge = -1;
    for (const [edge, q] of LADDER) {
      if (edge !== cvEdge) { cv = scaleCanvas(d.img, d.w, d.h, edge); cvEdge = edge; }
      const b = await toBlob(cv, q);
      if (b && b.size <= maxBytes) return b;
    }
    return null;
  }

  // 一张图 → { full, thumb } 两个 Blob。**压不出来就抛**，没有"原样放过"的退路 ——
  // 除了下面那一处（本来就是合规 jpeg 才放行）。
  async function renderVariants(file, maxBytes) {
    const d = await decode(file);
    try {
      if (!d.w || !d.h) throw new Error('读不出这张图的尺寸');
      const longest = Math.max(d.w, d.h);

      // 已经是"合规的 jpeg"就**原样过**，不重编码 —— 重编码会白丢一代画质，
      // 而这在"换一张阵容图""重新提交"这类场景里是常态。
      // 安全性不受影响：对象上的 Content-Type 是**签进签名里**的 image/jpeg，
      // 与文件真实内容无关，所以这条捷径开不出"往图片域名塞 HTML"的口子。
      const passthrough = file.type === 'image/jpeg' && file.size <= maxBytes && longest <= MAX_EDGE;

      let full = passthrough ? file : await ladderToFit(d, maxBytes);
      if (!full) throw new Error(`这张图压不到 ${bytes(maxBytes)} 以下，换一张试试`);

      const thumb = await toBlob(scaleCanvas(d.img, d.w, d.h, THUMB_EDGE), THUMB_Q);
      if (!thumb) throw new Error('缩略图生成失败');
      return { full, thumb };
    } finally {
      d.release();
    }
  }

  // 要令牌。**用 urlencoded 而不是 JSON** —— 这样服务端不必为了它挂 express.json()。
  async function signUploads(kind, count) {
    let res;
    try {
      res = await fetch('/uploads/sign', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: new URLSearchParams({ kind, count: String(count) }),
      });
    } catch (e) {
      throw new Error('连不上服务器，检查一下网络');
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* 不是 JSON 就走下面的通用报错 */ }
    if (res.status === 401) throw new Error('登录状态已过期，刷新页面重新登录');
    if (!res.ok) throw new Error((data && data.error) || `服务端拒绝了（${res.status}）`);
    if (!data || !Array.isArray(data.items) || data.items.length !== count) {
      throw new Error('服务端没给出上传地址');
    }
    return data;
  }

  // 直传一张。headers **原样用服务端下发的** —— 它们是签进签名里的，
  // 改一个字（哪怕只是大小写或多余空格）都会 403 SignatureDoesNotMatch。
  async function putObject(url, blob, headers) {
    let res;
    try {
      res = await fetch(url, { method: 'PUT', body: blob, headers });
    } catch (e) {
      throw new Error('传到图床失败，检查一下网络');
    }
    if (!res.ok) throw new Error(`传到图床失败（${res.status}）`);
  }

  // 把令牌写成隐藏 input 塞进表单。**先清掉上一轮注入的** —— 提交失败后重试会再走
  // 一遍这个函数，不清就会注入两份，同一张图被提交两次。
  function injectTokens(form, field, tokens) {
    form.querySelectorAll('[data-upload-token]').forEach((el) => el.remove());
    for (const t of tokens) {
      const inp = document.createElement('input');
      inp.type = 'hidden';
      inp.name = field;
      inp.value = t;
      inp.setAttribute('data-upload-token', '');
      form.appendChild(inp);
    }
  }

  function wireUpload() {
    Array.prototype.forEach.call(document.querySelectorAll('form[data-upload-kind]'), (form) => {
      const inputs = Array.from(form.querySelectorAll('input[type="file"]'));
      if (!inputs.length) return;

      const kind = form.dataset.uploadKind;
      const field = form.dataset.keyField || 'images';
      // 上限由服务端渲染进来（唯一真源在服务端），拿不到就退回 1MB。
      // 服务端提交时还会用 HeadObject 复核一遍体积，所以这里只是个"别白传"的前置判断。
      const maxBytes = Number(form.dataset.uploadMaxBytes) || MB;

      // 压缩 + 上传要好几秒（手机上更久），得让人看见在动，不然会以为按了没反应
      const note = document.createElement('p');
      note.className = 'muted compress-msg';
      note.setAttribute('aria-live', 'polite');   // 读屏软件也念一句
      const anchor = form.querySelector('button[type="submit"]') || form.lastElementChild;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(note, anchor.nextSibling);

      let busy = false;
      const fail = (msg) => {
        busy = false;                              // 失败要复位，否则重试时这个监听会直接放行
        note.textContent = msg;
        note.classList.add('is-warn');
      };

      // 万一提交没走成（网络断了、用户按了停止），页面还在，busy 得放开。
      // 换文件就重新武装（拖拽那半 dispatchEvent 的 change 也会走到这儿）。
      inputs.forEach((inp) => inp.addEventListener('change', () => {
        busy = false;
        note.textContent = '';
        note.classList.remove('is-warn');
      }));

      form.addEventListener('submit', (e) => {
        if (busy) return;                          // 第二次进来是我们自己 form.submit() 那一次

        const files = [];
        inputs.forEach((inp) => Array.from(inp.files || []).forEach((f) => files.push(f)));

        // 没选图就**照常提交** —— /score 只改分数、/lineup 只改说明都走这条路。
        // （旧代码这里判的是"值不值得压"，语义完全不同，别照抄。）
        if (!files.length) return;

        const notImage = files.find((f) => !COMPRESSIBLE.test(f.type || ''));
        if (notImage) {
          e.preventDefault();
          fail(`只收 jpg / png / webp：${notImage.name}`);
          return;
        }

        e.preventDefault();
        busy = true;
        note.classList.remove('is-warn');
        note.textContent = '准备中…';

        (async () => {
          try {
            // 1. 先全压完 —— 失败了也一个对象都没产生
            const variants = [];
            for (let i = 0; i < files.length; i++) {
              note.textContent = `正在压缩第 ${i + 1}/${files.length} 张…`;
              variants.push(await renderVariants(files[i], maxBytes));
            }
            const before = files.reduce((n, f) => n + f.size, 0);
            const after = variants.reduce((n, v) => n + v.full.size + v.thumb.size, 0);

            // 2. 再要令牌（顺带做配额预检：赛期在不在、阵容额度够不够）
            note.textContent = '正在上传…';
            const { items } = await signUploads(kind, files.length);

            // 3. 再 PUT：每张两个对象（原图 + 缩略图）
            const tokens = [];
            for (let i = 0; i < variants.length; i++) {
              note.textContent = `正在上传第 ${i + 1}/${files.length} 张…`;
              await putObject(items[i].url, variants[i].full, items[i].headers);
              await putObject(items[i].thumbUrl, variants[i].thumb, items[i].headers);
              tokens.push(items[i].token);
            }

            note.textContent = `传好了 ${variants.length} 张 · ${bytes(before)} → ${bytes(after)}，正在提交…`;
            injectTokens(form, field, tokens);
            // form.submit() 不触发 submit 事件，不会再绕回上面那个监听（busy 也还立着）
            form.submit();
          } catch (err) {
            // ★ 和旧代码最大的语义差别：**失败不再放行提交**。
            //   旧代码是"出什么事都别拦着提交，原样传"——那时服务端会收下文件。
            //   现在服务端收不到字节，放行等于提交一个空表单（图静默地没了）。
            fail(`上传失败：${err.message}。图片还在你手上，重试一次就行。`);
          }
        })();
      });
    });
  }

  wireUpload();

  /* ==========================================================================
     二、拖拽 / 粘贴（下面沿用原来的写法）
     拖拽只有桌面开；**粘贴两边都留** —— 手机上从相册选仍是主路，
     但外接键盘、部分输入法也贴得出图，为拖拽那条判断把粘贴一起关掉没道理。
     ========================================================================== */

  if (!canAssignFiles()) return;

  var inputs = document.querySelectorAll('input[type="file"]');
  if (!inputs.length) return;

  // 以触摸为主（手机、平板）的设备上没有拖拽这回事，摆一个拖不动的虚线框
  // 外加一句「可以把图片拖进来」纯粹是添乱 —— 那边本来就是点一下从相册选。
  // 所以**只跳过拖拽那一套**（虚线框、提示、drag 监听），页面上不多出任何东西；
  // 这里**不能 return**，下面的粘贴是另一回事，手机上照样可用。
  // （注意：上传那一半在上面，手机照样有，别把 return 提到它前面去。）
  var touchOnly = !!(window.matchMedia
    && window.matchMedia('(hover: none) and (pointer: coarse)').matches);

  // 判据必须和上面 COMPRESSIBLE 一致：这里放行、上面会拒，用户白拖一次。
  // （从前它对应的是服务端 multer 的 EXT 表，那张表随直传一起没了。）
  var OK_TYPE = /^image\/(jpeg|png|webp)$/;
  var OK_EXT = /\.(jpe?g|png|webp)$/i;

  function isImage(f) {
    // 浏览器报的 type 可能是空串（系统不认识的文件、某些 Linux 桌面），那就退回看扩展名
    return f.type ? OK_TYPE.test(f.type) : OK_EXT.test(f.name || '');
  }

  // 最多列 keep 个文件名，多了就「等」—— 拖 6 张时把名字全摊出来会占三行
  function names(files, keep) {
    var s = files.slice(0, keep).map(function (f) { return f.name; }).join('、');
    return files.length > keep ? s + ' 等 ' + files.length + ' 个' : s;
  }

  // 拖的是文件，还是选中的文字 / 页面里的图片链接？
  // 后者不该亮框，更不该被我们拦下来（拦了就拖不动文字了）。
  function hasFiles(e) {
    var t = e.dataTransfer && e.dataTransfer.types;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) if (t[i] === 'Files') return true;
    return false;
  }

  function say(z, text, warn) {
    z.msg.textContent = text;
    z.msg.classList.add('is-on');
    z.msg.classList.toggle('is-warn', !!warn);
  }

  // 拖进来 / 粘贴进来的文件 → 原生 input。这是整个功能的核心一步。
  // how 只是提示语里的出处（「拖进来的」「粘贴的」），不影响任何判断。
  function accept(z, list, how) {
    var all = Array.prototype.slice.call(list || []);
    if (!all.length) return;

    // 还能再选几张：多选看 data-max（阵容墙的剩余额度），单选恒为 1。
    // data-max 没写时按不限 —— 服务端仍会兜底，这里只是少让用户白跑一趟。
    var cap = z.input.multiple
      ? (z.input.dataset.max === undefined ? Infinity : Number(z.input.dataset.max))
      : 1;

    if (!cap) {
      say(z, '已经传满了，先删掉几张再传。', true);
      return;
    }

    var ok = [];
    var bad = [];
    all.forEach(function (f) { (isImage(f) ? ok : bad).push(f); });
    var over = Math.max(0, ok.length - cap);
    ok = ok.slice(0, cap);

    if (!ok.length) {
      say(z, how + '的 ' + all.length + ' 个都不是图片（只认 jpg / png / webp）：' + names(bad, 2), true);
      return;
    }

    var dt = new DataTransfer();
    ok.forEach(function (f) { dt.items.add(f); });
    z.input.files = dt.files;
    // 有别的脚本挂了 change 的话也该收到；bubbles 是给外层监听用的
    // （上面那个 change 监听会借它把 busy 复位、把提示清掉）
    z.input.dispatchEvent(new Event('change', { bubbles: true }));

    var total = ok.reduce(function (n, f) { return n + f.size; }, 0);
    var parts = ['已选 ' + ok.length + ' 张 · ' + bytes(total) + ' · ' + names(ok, 2)];
    if (over) parts.push('最多 ' + cap + ' 张，多出来的 ' + over + ' 张没收');
    if (bad.length) parts.push('忽略 ' + bad.length + ' 个非图片文件：' + names(bad, 2));
    say(z, parts.join(' · '), !!(over || bad.length));
  }

  var zones = [];

  Array.prototype.forEach.call(inputs, function (input) {
    var box = input.closest('label') || input.parentNode;   // 没包在 label 里就退回父节点
    if (!box || !box.classList) return;

    // 结果行两边都要有：拖进来的结果和粘贴的结果都写在这一行上
    // （默认 display:none，没触发过的时候页面上看不出多了个元素）。
    var msg = document.createElement('span');
    msg.className = 'drop-msg';
    msg.setAttribute('aria-live', 'polite');   // 拖完让读屏软件念一句结果

    var z = { input: input, box: box, msg: msg, depth: 0 };
    zones.push(z);

    // 触摸设备到此为止：不摆虚线框、不提拖拽，只要下面粘贴能把结果说出来。
    if (touchOnly) {
      box.appendChild(msg);
      return;
    }

    var hint = document.createElement('small');
    hint.className = 'muted drop-hint';
    hint.textContent = input.multiple
      ? '也可以把图片拖进来，或直接粘贴（Ctrl+V），一次多张'
      : '也可以把图片拖进来，或直接粘贴（Ctrl+V）';

    // 先把过渡关掉再加类。.drop-field 上有 border-color / background-color 的过渡
    // （拖进来时描边转金要用它），而加类的这一刻浏览器会从「没有框」过渡到「有框」——
    // 页面刚打开就能看见虚线框淡入一下。先把 transition 压成 none、逼一次重排让
    // 上面这条落地，再放开：框立即出现，之后拖拽的高亮照样有过渡。
    box.style.transition = 'none';
    box.classList.add('drop-field');   // 虚线框：得让人看出来这里能放东西
    void box.offsetHeight;
    box.style.transition = '';

    box.appendChild(hint);             // 追加在末尾，避开模板里原有的 <small> 提示
    box.appendChild(msg);

    box.addEventListener('dragenter', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      z.depth++;
      box.classList.add('is-dragover');
    });

    // ★ 必须拦 dragover：不拦的话浏览器判定这里「不接受放置」，drop 事件压根不会来，
    //   松手时反而按默认行为去打开那个文件（整页跳走）。
    box.addEventListener('dragover', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    // dragenter/dragleave 会随鼠标穿过子元素成对反复触发，所以用计数器：
    // 归零才算真的拖出去了，不然框会一直闪。
    box.addEventListener('dragleave', function () {
      if (--z.depth <= 0) {
        z.depth = 0;
        box.classList.remove('is-dragover');
      }
    });

    box.addEventListener('drop', function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();          // 别让下面那个文档级兜底再处理一遍
      z.depth = 0;
      box.classList.remove('is-dragover');
      accept(z, e.dataTransfer.files, '拖进来');
    });
  });

  /* ---- 粘贴（2026-10-19 加） --------------------------------------------
     截图之后直接 Ctrl+V / ⌘V —— 不必先存成文件再点选，手机上也能省一趟相册。
     接管的前提是**剪贴板里真有文件**：贴文字时返回空数组，浏览器自己的粘贴
     行为原样发生（阵容说明那个 textarea 就靠这一条）。

     files 和 items 两条路都要看：从网页上右键复制图片，Chrome 把 File 放在
     `items`（kind='file'）里、Safari 只给 items；从文件管理器复制文件时
     才落在 `files` 上。漏掉任一条都会出现"明明复制了却贴不上"的设备差异。 */
  function clipboardFiles(e) {
    var cd = e.clipboardData;
    if (!cd) return [];
    if (cd.files && cd.files.length) return Array.prototype.slice.call(cd.files);
    var out = [];
    var items = cd.items || [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === 'file') {
        var f = items[i].getAsFile && items[i].getAsFile();
        if (f) out.push(f);
      }
    }
    return out;
  }

  // 挂在 document 上：贴图之前用户不需要先点一下那个文件框（快捷键就是全部）。
  // 页面上只有一个文件框（阵容图，见 views/lineup.ejs），所以固定落到 zones[0]，
  // 和上面"拖到框外"那条兜底的取法一致。
  document.addEventListener('paste', function (e) {
    var files = clipboardFiles(e);
    if (!files.length) return;
    if (!zones.length) return;      // 没有文件框（已传满 / 不是上传页）：别拦默认行为
    e.preventDefault();
    accept(zones[0], files, '粘贴');
  });

  // 拖偏了（没落在虚线框里）也得拦：不拦的话浏览器会直接打开那个文件、整页跳走，
  // 用户只会觉得「拖一下页面就没了」。顺手在框上提一句，别让他以为拖成功了。
  document.addEventListener('dragover', function (e) {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (zones.length === 1) say(zones[0], '图要拖进虚线框里才算选上。', true);
  });
})();
