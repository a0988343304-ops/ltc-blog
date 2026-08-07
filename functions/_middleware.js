/**
 * 網域正規化：把非正式網域的請求 301 導到 peaceyen.net。
 *
 * 為什麼不用 _redirects：Cloudflare Pages 的 _redirects **只比對路徑**，
 * 來源寫成 https://舊網域/* 不會生效（實測回 200 而非 301）。
 * 跨網域收斂只能在 Functions 這一層做。
 *
 * 不收斂的話同一份內容會同時活在 peaceyen.net、www.peaceyen.net
 * 與 ltc-blog.pages.dev 三個網址上，搜尋權重被稀釋。
 */

const CANONICAL_HOST = 'peaceyen.net';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const host = url.hostname;

  // 這些要收斂：www 與正式的 pages.dev 網址。
  // 刻意**不**收斂 <hash>.ltc-blog.pages.dev —— 那是每次部署的預覽網址，
  // 收掉之後就沒辦法單獨驗證某一版部署了。
  const shouldRedirect =
    host === `www.${CANONICAL_HOST}` || host === 'ltc-blog.pages.dev';

  if (shouldRedirect) {
    url.hostname = CANONICAL_HOST;
    url.protocol = 'https:';
    url.port = '';
    return Response.redirect(url.toString(), 301);
  }

  return context.next();
}
