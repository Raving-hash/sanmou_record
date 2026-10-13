/* ==========================================================================
   上传页的两个增强。两半彼此独立：任何一半失效都不影响另一半，
   也都不影响表单本身 —— 没有 JS、脚本没加载、浏览器太老，点选提交一切照旧。

   一、★提交前在浏览器里把图压小（所有设备，手机尤其需要）
      手机原图动辄 3~5MB，六张就是 20MB+，全要挤那条很细的隧道，
      传一半断掉是常事 —— 服务端日志里 "POST /lineup 400 0" 就是被截断的上传。
      注意：服务端 upload.js 的 compressUploads 是**收完**才压的，
      所以那边压得再好也省不下上传流量，必须在浏览器里先压。

      做法是缩到长边 MAX_EDGE、重编码成 jpeg，通常 3MB → 300KB 上下，
      服务端拿到后一般直接落在它压缩阶梯的第一档（4096/q84，不缩尺寸），
      所以画质损失可以忽略。

      ★方向：手机竖拍的照片方向记在 EXIF 里，canvas 重编码会把 EXIF 丢掉。
      所以这里用 <img> 解码 —— 现代浏览器渲染 <img> 时默认就按 EXIF 摆正
      （image-orientation 默认值 from-image），drawImage 拿到的已经是摆正的位图。
      服务端 sharp 的 rotate() 因此无从下手，但也不再需要。

      任何一步出错（浏览器不支持、解码失败、压完反而更大）一律**退回原文件**放行，
      最坏也就是回到今天的样子。

   二、拖拽（仅桌面）
      做法：把拖进来的文件灌进那个**原生** <input type="file">，表单照原样提交 ——
      路由层、multer、压缩流水线一行都不用改，服务端完全不知道有拖拽这回事。
      （灌得进去是因为 input.files 允许赋一个 DataTransfer 的 FileList。）

      所以这是**增强**，不是依赖：脚本没加载、浏览器太老、JS 被关了，
      页面就退回原来的样子，点 input 选文件一切照旧。

      给模板留的钩子只有 input 上的两个：
        multiple      有 = 能拖多张；没有 = 只留第一张
        data-max="N"  还能再选几张（阵容墙的剩余额度，见 views/lineup.ejs）。
                      拖多了截到前 N 张并说明，免得白传 40MB 才被服务端打回。
      其余 DOM —— 虚线框 .drop-field、说明 .drop-hint、结果 .drop-msg ——
      全在这里生成，模板里没有：没 JS 的页面上不该出现「可以拖进来」这种做不到的承诺。
   ========================================================================== */
(function () {
  'use strict';

  var MB = 1024 * 1024;

  function bytes(n) {
    return n >= MB ? (n / MB).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // 能不能把 DataTransfer 的文件灌进原生 input？两半都靠它：
  // 拖拽靠它把文件塞进去，压缩靠它把压完的换回来。不能的话两半都不成立。
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
     一、提交前压缩
     这一半本身就要 Promise / canvas / DataTransfer，已经进不了老浏览器，
     所以用现代语法写，不跟着下面那半用 var + function 绕。
     ========================================================================== */

  const MAX_EDGE = 2560;            // 长边上限。截图里的字要看得清，别缩太狠
  const QUALITY = 0.85;             // 比服务端第一档的 84 略高，给二次编码留余量
  const WORTH_BYTES = 300 * 1024;   // 小于这个体积的不值得动
  const SKIP_BYTES = 600 * 1024;    // 尺寸本来就不大、体积也还行 → 原样放过，免得白丢一次画质

  const COMPRESSIBLE = /^image\/(jpeg|png|webp)$/;

  function worthCompressing(f) {
    return !!f && COMPRESSIBLE.test(f.type || '') && f.size > WORTH_BYTES;
  }

  function jpgName(name) {
    return String(name || 'image').replace(/\.[^.]+$/, '') + '.jpg';
  }

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
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('解码失败')); };
      img.src = url;
    });
  }

  // 压一张。返回压好的 File；判断不该压、或压不动，返回 null（调用方原样放行）
  async function shrink(file) {
    const d = await decode(file);
    try {
      if (!d.w || !d.h) return null;

      const scale = Math.min(1, MAX_EDGE / Math.max(d.w, d.h));
      if (scale === 1 && file.size <= SKIP_BYTES) return null;

      const cw = Math.max(1, Math.round(d.w * scale));
      const ch = Math.max(1, Math.round(d.h * scale));
      const cv = document.createElement('canvas');
      cv.width = cw;
      cv.height = ch;

      const ctx = cv.getContext('2d');
      // png 的透明区落成白底 —— 和服务端 sharp 的 flatten({background:'#ffffff'}) 保持一致，
      // 不然透明处会变黑
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(d.img, 0, 0, cw, ch);

      const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/jpeg', QUALITY));
      // 压完反而更大就别换了（个别已经很优的图会这样）
      if (!blob || blob.size >= file.size) return null;

      return new File([blob], jpgName(file.name), { type: 'image/jpeg', lastModified: Date.now() });
    } finally {
      d.release();
    }
  }

  // 一个 input 里的文件挨个压，压完把 FileList 换掉。
  // 返回 { n, before, after }：n 是真换掉了几张，before/after 是那几张的字节数
  async function compressInput(input, note, label) {
    const picked = Array.from(input.files || []);
    if (!picked.some(worthCompressing)) return { n: 0, before: 0, after: 0 };

    const out = [];
    let n = 0, before = 0, after = 0;

    for (let i = 0; i < picked.length; i++) {
      const f = picked[i];
      if (worthCompressing(f)) {
        note.textContent = `${label}正在压缩第 ${i + 1}/${picked.length} 张…`;
        let small = null;
        try {
          small = await shrink(f);
        } catch (e) {
          small = null;                      // 压不动就原样传，别把人卡在这儿
        }
        if (small) { out.push(small); n++; before += f.size; after += small.size; continue; }
      }
      out.push(f);
    }

    if (n) {
      const dt = new DataTransfer();
      out.forEach((f) => dt.items.add(f));
      input.files = dt.files;
    }
    return { n, before, after };
  }

  function wireCompress() {
    Array.prototype.forEach.call(document.querySelectorAll('form'), (form) => {
      const inputs = Array.from(form.querySelectorAll('input[type="file"]'));
      if (!inputs.length) return;

      // 压缩要花几秒（手机上更久），得让人看见在动，不然会以为按了没反应
      const note = document.createElement('p');
      note.className = 'muted compress-msg';
      note.setAttribute('aria-live', 'polite');   // 读屏软件也念一句
      const anchor = form.querySelector('button[type="submit"]') || form.lastElementChild;
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(note, anchor.nextSibling);

      let busy = false;
      // 万一提交没走成（网络断了、用户按了停止），页面还在，busy 得放开，
      // 否则他重选一批图再提交就不会被压了。换文件就重新武装。
      inputs.forEach((inp) => inp.addEventListener('change', () => { busy = false; }));

      form.addEventListener('submit', (e) => {
        if (busy) return;                          // 第二次进来是压缩完之后我们自己发的
        if (!inputs.some((inp) => Array.from(inp.files || []).some(worthCompressing))) return;
        if (!canAssignFiles()) return;             // 换不回去，那就别拦这一下

        e.preventDefault();
        busy = true;

        (async () => {
          let n = 0, before = 0, after = 0;
          try {
            for (let i = 0; i < inputs.length; i++) {
              const label = inputs.length > 1 ? `第 ${i + 1}/${inputs.length} 项 · ` : '';
              const r = await compressInput(inputs[i], note, label);
              n += r.n; before += r.before; after += r.after;
            }
          } catch (e) {
            /* 出什么事都别拦着提交，原样传 */
          }
          if (n) {
            note.textContent = `已压缩 ${n} 张 · ${bytes(before)} → ${bytes(after)}，正在上传…`;
          } else {
            note.textContent = '';
          }
          // form.submit() 不触发 submit 事件，不会再绕回上面那个监听
          form.submit();
        })();
      });
    });
  }

  wireCompress();

  /* ==========================================================================
     二、拖拽（仅桌面，下面沿用原来的写法）
     ========================================================================== */

  if (!canAssignFiles()) return;

  var inputs = document.querySelectorAll('input[type="file"]');
  if (!inputs.length) return;

  // 以触摸为主（手机、平板）的设备上没有拖拽这回事，摆一个拖不动的虚线框
  // 外加一句「可以把图片拖进来」纯粹是添乱 —— 那边本来就是点一下从相册选。
  // 于是整段不启用，页面上不会多出任何东西，点选照旧。
  // （注意：压缩那一半在上面，手机照样有，别把 return 提到它前面去。）
  if (window.matchMedia && window.matchMedia('(hover: none) and (pointer: coarse)').matches) return;

  // 判据必须和 upload.js 里 multer 的 fileFilter（EXT 表）一致：
  // 这里放行服务端会拒，这里误拦用户白拖一次。
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

  // 拖进来的文件 → 原生 input。这是整个功能的核心一步。
  function accept(z, list) {
    var all = Array.prototype.slice.call(list || []);
    if (!all.length) return;

    // 还能再选几张：多选看 data-max（阵容墙的剩余额度），单选恒为 1。
    // data-max 没写时按不限 —— 服务端仍会兜底，这里只是少让用户白跑一趟。
    var cap = z.input.multiple
      ? (z.input.dataset.max === undefined ? Infinity : Number(z.input.dataset.max))
      : 1;

    if (!cap) {
      say(z, '已经传满了，先删掉几张再拖。', true);
      return;
    }

    var ok = [];
    var bad = [];
    all.forEach(function (f) { (isImage(f) ? ok : bad).push(f); });
    var over = Math.max(0, ok.length - cap);
    ok = ok.slice(0, cap);

    if (!ok.length) {
      say(z, '拖进来的 ' + all.length + ' 个都不是图片（只认 jpg / png / webp）：' + names(bad, 2), true);
      return;
    }

    var dt = new DataTransfer();
    ok.forEach(function (f) { dt.items.add(f); });
    z.input.files = dt.files;
    // 有别的脚本挂了 change 的话也该收到；bubbles 是给外层监听用的
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

    var hint = document.createElement('small');
    hint.className = 'muted drop-hint';
    hint.textContent = input.multiple ? '也可以把图片拖进来，一次拖多张' : '也可以把图片拖进来';

    var msg = document.createElement('span');
    msg.className = 'drop-msg';
    msg.setAttribute('aria-live', 'polite');   // 拖完让读屏软件念一句结果

    var z = { input: input, box: box, msg: msg, depth: 0 };
    zones.push(z);

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
      accept(z, e.dataTransfer.files);
    });
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
