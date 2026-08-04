/**
 * 數字跳動動畫（顧問成果頁）。
 *
 * HTML 裡本來就寫著最終數字，這支腳本只是把它先歸零再跑上去。
 * 沒有 JS、腳本載入失敗、或使用者偏好減少動態時，畫面顯示的仍是正確數值。
 */
(function () {
  'use strict';

  var nodes = document.querySelectorAll('[data-count-to]');
  if (!nodes.length) return;

  // 使用者在系統設定要求減少動態時，不要讓數字亂跳
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;

  var nf = new Intl.NumberFormat('en-US');

  function run(el) {
    var target = Number(el.getAttribute('data-count-to'));
    var suffix = el.getAttribute('data-suffix') || '';
    if (!isFinite(target)) return;

    var duration = 1100;
    var start = null;

    // 數字寬度會隨著位數變動，先鎖住現在的寬度避免版面跳動
    el.style.minWidth = el.getBoundingClientRect().width + 'px';

    function step(now) {
      if (start === null) start = now;
      var t = Math.min((now - start) / duration, 1);
      // easeOutCubic：開頭快、結尾慢，收得比線性好看
      var eased = 1 - Math.pow(1 - t, 3);
      el.textContent = nf.format(Math.round(target * eased)) + suffix;
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = nf.format(target) + suffix;
    }

    requestAnimationFrame(step);
  }

  var io = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        io.unobserve(entry.target);   // 只跑一次，捲回去不重播
        run(entry.target);
      });
    },
    { threshold: 0.4 },
  );

  for (var i = 0; i < nodes.length; i++) io.observe(nodes[i]);
})();
