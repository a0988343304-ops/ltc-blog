/**
 * 還原被保護的 Email 位址（聯絡方式頁）。
 *
 * HTML 裡存的是 base64，畫面上顯示的是「a0988343304（at）gmail（dot）com」。
 * 收信箱的爬蟲多半只是拿 \S+@\S+ 掃原始碼，這樣就掃不到；
 * 真人開啟頁面時由這支腳本還原成可以直接點的 mailto 連結。
 *
 * 這不是加密，只是提高成本。會執行 JavaScript 的爬蟲仍然拿得到——
 * 要完全避免就只能改成聯絡表單。
 */
(function () {
  'use strict';

  var nodes = document.querySelectorAll('[data-email]');

  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var addr;

    try {
      addr = decodeURIComponent(escape(atob(el.getAttribute('data-email'))));
    } catch (e) {
      continue;   // 解不開就維持原本那份人類看得懂的寫法
    }
    if (!addr) continue;

    var a = document.createElement('a');
    a.className = el.className;
    a.href = 'mailto:' + addr;
    a.textContent = addr;
    // 還原後這個屬性沒有用處了，留著只是給爬蟲多一份線索
    el.parentNode.replaceChild(a, el);
  }
})();
