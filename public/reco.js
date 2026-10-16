/* 阵容纠正面板里那点增强（views/partials/reco.ejs 的 .reco-slot / .reco-other）。

   只干一件事：**在「其他」框里打了字（或从补全列表里挑了一个）的时候，顺手把同一格
   那个 `__other__` 单选框勾上。**

   为什么必须有这一下：那一格是一组单选框（各个候选 / 其他 / 不确定），而**表单只提交被勾中
   的那一个**。玩家打了字却没先点「其他」的话，提交上去那一格等于"没动" —— 而且一声不响，
   看着就像名字没存上。补全本身不需要脚本（模板里那个 list 属性就够了，见
   lineup-gallery.ejs 的 <datalist>），这里补的是"打完字还得记得点一下单选"这一步。

   是增强不是依赖（和 lightbox.js / comments.js / report.js 同一个约定）：脚本没跑时，
   先点「其他」再打字，功能一模一样。所以挂在页脚、找不到元素就自己退出。 */
(function () {
  'use strict';

  // 卡片上可能有九格，一格一个输入框。NodeList 上没有 forEach 的老浏览器也能跑，
  // 所以照 wall.js 的写法用 [].slice.call —— 这个站是要照顾旧手机的。
  [].slice.call(document.querySelectorAll('.reco-other')).forEach(function (box) {
    var slot = box.closest ? box.closest('.reco-slot') : null;
    if (!slot) return;
    var radio = slot.querySelector('input[type=radio][value="__other__"]');
    if (!radio) return;
    // `input` 就够：手打和"从补全里选一个"都触发它（`change` 要等失焦，慢半拍，
    // 而提交是不用失焦的 —— 打完字直接点「保存」的人不在少数）。
    box.addEventListener('input', function () {
      if (box.value) radio.checked = true;
      // 清空时**什么都不做**：那多半是"不想填这一格了"，去勾别的反而更添乱；
      // 真要清空，点「不确定」那个单选框（它的意思就是清空，见 views/partials/reco.ejs）。
    });
  });
})();
