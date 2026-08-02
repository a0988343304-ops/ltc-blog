/**
 * 瀏覽計數器（需求 8）
 *
 * 行為：
 *  1. 為「目前這一頁」的 slug 計數 +1，並顯示新的數字。
 *  2. 把頁面上其他 slug（首頁卡片）的計數一次讀回來填上。
 *
 * 直接打 Supabase REST API，不載入 supabase-js，省一支外部 script。
 * anon key 本來就是設計成公開放在前端的：真正的防線是資料表的 RLS 政策。
 * 尚未設定 Supabase 時，整段安靜跳過，頁面其餘功能不受影響。
 */
(function () {
  'use strict';

  var cfg = (window.__SITE__ || {}).supabase || {};
  if (!cfg.url || !cfg.anonKey) return;

  var base = String(cfg.url).replace(/\/+$/, '');
  var headers = {
    apikey: cfg.anonKey,
    Authorization: 'Bearer ' + cfg.anonKey,
    'Content-Type': 'application/json',
  };

  var nf = new Intl.NumberFormat('zh-TW');

  function paint(slug, n) {
    var nodes = document.querySelectorAll('[data-views="' + slug.replace(/"/g, '\\"') + '"]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = nf.format(n);
      nodes[i].removeAttribute('aria-busy');
    }
  }

  function settleUnknown() {
    var nodes = document.querySelectorAll('[data-views][aria-busy]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = '0';
      nodes[i].removeAttribute('aria-busy');
    }
  }

  var self = document.body.getAttribute('data-page-slug');

  // 1) 本頁 +1
  var mine = self
    ? fetch(base + '/rest/v1/rpc/increment_view', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ page_slug: self }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (n) { if (typeof n === 'number') paint(self, n); })
        .catch(function () {})
    : Promise.resolve();

  // 2) 其他 slug 一次讀回（首頁卡片用）
  var others = [];
  var marks = document.querySelectorAll('[data-views]');
  for (var i = 0; i < marks.length; i++) {
    var s = marks[i].getAttribute('data-views');
    if (s && s !== self && others.indexOf(s) === -1) others.push(s);
  }

  var rest = others.length
    ? fetch(
        base + '/rest/v1/page_views?select=slug,views&slug=in.(' +
          others.map(function (s) { return '"' + s + '"'; }).join(',') + ')',
        { headers: headers },
      )
        .then(function (r) { return r.ok ? r.json() : []; })
        .then(function (rows) {
          if (!Array.isArray(rows)) return;
          rows.forEach(function (row) { paint(row.slug, row.views); });
        })
        .catch(function () {})
    : Promise.resolve();

  // 兩邊都跑完後，還沒拿到數字的（尚無紀錄）顯示 0
  Promise.all([mine, rest]).then(settleUnknown);
})();
