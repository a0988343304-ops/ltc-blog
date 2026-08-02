/**
 * 瀏覽計數器（前端）
 *
 * 資料來自本站的 /api/views（Cloudflare Pages Functions + D1）。
 * 頁面上任何 <span data-views="<slug>"> 都會被填上數字。
 *
 * 注意：首頁的文章卡片本身是靜態 HTML，這支腳本只負責把「數字」填進既有的
 * 欄位，不會生成任何卡片——列表的 SEO 不受影響。
 *
 * 同一個瀏覽器分頁工作階段內，同一頁只計一次，重新整理不會灌水。
 */
(function () {
  'use strict';

  var cfg = (window.__SITE__ || {}).counter || {};
  if (!cfg.apiBase) return;

  var api = String(cfg.apiBase).replace(/\/+$/, '') + '/api/views';
  var self = document.body.getAttribute('data-page-slug');
  var nf = new Intl.NumberFormat('zh-TW');

  function paint(slug, n) {
    var nodes = document.querySelectorAll('[data-views="' + slug.replace(/"/g, '\\"') + '"]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = nf.format(n);
      nodes[i].removeAttribute('aria-busy');
    }
  }

  function settle() {
    var nodes = document.querySelectorAll('[data-views][aria-busy]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = '0';
      nodes[i].removeAttribute('aria-busy');
    }
  }

  /** 這個工作階段是否已經為某個 slug 計過數 */
  function alreadyCounted(slug) {
    try {
      var key = 'viewed:' + slug;
      if (sessionStorage.getItem(key)) return true;
      sessionStorage.setItem(key, '1');
      return false;
    } catch (e) {
      return false; // 隱私模式下 sessionStorage 可能不可用，就每次都計
    }
  }

  // 本頁 +1
  var bump = self && !alreadyCounted(self)
    ? fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug: self }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; })
    : Promise.resolve(null);

  // 全站計數一次讀回（首頁卡片、頁首的全站計數都靠這個）
  var all = fetch(api, { headers: { Accept: 'application/json' } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .catch(function () { return null; });

  Promise.all([bump, all]).then(function (res) {
    var mine = res[0];
    var map = res[1];

    if (map && typeof map === 'object') {
      for (var slug in map) {
        if (Object.prototype.hasOwnProperty.call(map, slug)) paint(slug, map[slug]);
      }
    }
    // 本頁的數字用 POST 回傳值覆蓋，確保含這次瀏覽
    if (mine && typeof mine.views === 'number') paint(mine.slug, mine.views);

    settle();
  });
})();
