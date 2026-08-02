/**
 * 瀏覽計數器 API（Cloudflare Pages Functions + D1）
 *
 *   GET  /api/views              → { "site-home": 12, "20260802-introduction": 5 }
 *   POST /api/views  {slug}      → { slug, views }   （該 slug +1，回傳新數字）
 *
 * 計數用 SQLite 的 upsert 一次完成，是原子操作，併發時不會掉數字。
 */

const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/;

// GitHub Pages 鏡像站也要能顯示與累計，所以需要 CORS 白名單。
const ALLOWED_ORIGINS = new Set([
  'https://ltc-blog.pages.dev',
  'https://a0988343304-ops.github.io',
  'http://localhost:4173',
]);

function headers(request, extra = {}) {
  const origin = request.headers.get('Origin');
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extra,
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Vary'] = 'Origin';
  }
  return h;
}

const json = (request, body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: headers(request) });

/** 預檢請求 */
export function onRequestOptions({ request }) {
  return new Response(null, {
    status: 204,
    headers: headers(request, {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    }),
  });
}

/** 一次取回全部計數，首頁卡片用 */
export async function onRequestGet({ request, env }) {
  try {
    const { results } = await env.DB
      .prepare('SELECT slug, views FROM page_views')
      .all();

    const map = {};
    for (const row of results ?? []) map[row.slug] = row.views;
    return json(request, map);
  } catch (err) {
    return json(request, { error: 'read failed', detail: String(err) }, 500);
  }
}

/** 指定 slug +1 */
export async function onRequestPost({ request, env }) {
  let slug;
  try {
    ({ slug } = await request.json());
  } catch {
    return json(request, { error: 'invalid json' }, 400);
  }

  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    return json(request, { error: 'invalid slug' }, 400);
  }

  try {
    const row = await env.DB
      .prepare(
        `INSERT INTO page_views (slug, views, updated_at)
         VALUES (?1, 1, datetime('now'))
         ON CONFLICT(slug) DO UPDATE
           SET views = views + 1,
               updated_at = datetime('now')
         RETURNING views`,
      )
      .bind(slug)
      .first();

    return json(request, { slug, views: row?.views ?? 1 });
  } catch (err) {
    return json(request, { error: 'write failed', detail: String(err) }, 500);
  }
}
