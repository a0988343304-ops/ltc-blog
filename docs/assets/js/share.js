/**
 * 「複製連結」按鈕。
 *
 * 按鈕在 HTML 裡預設 hidden，這支腳本載入後才打開——沒有 JS 的訪客
 * 不會看到一顆按了沒反應的按鈕。Facebook 與 LINE 是純連結，不受影響。
 *
 * 文章開頭與結尾各有一組，兩組都要能用，且各自回報自己的狀態。
 */
(function () {
  'use strict';

  var buttons = document.querySelectorAll('.share__btn[data-share-url]');
  if (!buttons.length) return;

  /** Clipboard API 不可用時的退路（非 HTTPS、舊瀏覽器） */
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      // 不能用 display:none，隱藏的元素選取不到
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  function setup(btn, index) {
    var box = btn.closest('.share') || btn.parentNode;
    var status = box.querySelector('.share__status');
    var timer = null;

    btn.hidden = false;

    function say(msg) {
      if (!status) return;
      status.textContent = msg;
      clearTimeout(timer);
      timer = setTimeout(function () { status.textContent = ''; }, 3000);
    }

    /**
     * 複製不成功時，直接把網址攤在畫面上讓人自己選取。
     * 只叫使用者「請手動複製」卻不給網址，等於沒有退路。
     */
    function showFallbackField(url) {
      if (box.querySelector('.share__fallback')) return;

      // 兩組分享列共存，id 必須各自唯一，否則 label 的 for 會指錯對象
      var id = 'share-url-field-' + index;

      var wrap = document.createElement('div');
      wrap.className = 'share__fallback';

      var label = document.createElement('label');
      label.textContent = '複製失敗，請手動選取這段網址：';
      label.setAttribute('for', id);

      var input = document.createElement('input');
      input.id = id;
      input.type = 'text';
      input.readOnly = true;
      input.value = url;

      wrap.appendChild(label);
      wrap.appendChild(input);
      box.appendChild(wrap);

      input.focus();
      input.select();
    }

    function fail(url) {
      say('複製失敗');
      showFallbackField(url);
    }

    btn.addEventListener('click', function () {
      var url = btn.getAttribute('data-share-url');
      if (!url) return;

      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(url).then(
          function () { say('已複製連結'); },
          function () { if (legacyCopy(url)) say('已複製連結'); else fail(url); },
        );
      } else if (legacyCopy(url)) {
        say('已複製連結');
      } else {
        fail(url);
      }
    });
  }

  for (var i = 0; i < buttons.length; i++) setup(buttons[i], i);
})();
