/**
 * 靜態網站產生器
 *
 * 對應需求：
 *  - 每篇文章輸出成 /<slug>/index.html，網址即 https://<站台>/<slug>
 *  - 首頁的文章卡片「直接寫死在 HTML 裡」，不靠 JavaScript 讀 JSON 生成（SEO）
 *  - 卡片與文章都標日期；更新日期由 git 最後提交時間自動帶入
 *  - 卡片依發布日期新到舊排序，新增 .md 檔即自動長出卡片
 *
 * CSS 策略：維持「外部檔 + 內容雜湊查詢字串」（static/_headers 對 /assets/*
 * 設一年 immutable，引用處帶 ?v=<hash>）。刻意「不」把 site.css 內嵌進
 * <style>——內嵌能省掉首屏一個 RTT，但會讓同一份 CSS 同時存在於 HTML 與
 * 外部檔案，且每頁都要重付一次未快取的成本。兩種做法只能擇一，這裡選外部檔。
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  cp, mkdir, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Renderer, marked } from 'marked';

const ROOT = dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = join(ROOT, 'content', 'posts');
const STATIC_DIR = join(ROOT, 'static');
const OUT_DIR = join(ROOT, 'docs'); // GitHub Pages 與 Cloudflare Pages 共用這個輸出目錄

const site = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'));

/**
 * 站台正式網址（去掉結尾斜線）。
 * 宣告在最前面，因為首頁與文章頁的樣板都要用它組絕對網址（og:image、JSON-LD）。
 */
const origin = (site.siteUrl || '').replace(/\/+$/, '');

/* -------------------------------------------------- 資產快取破壞（版本）--- */

/**
 * static/assets 底下每個檔案的內容雜湊。
 *
 * docs/_headers 對 /assets/* 設了一年 immutable，檔名本身又沒有雜湊，
 * 所以引用時一律補上 ?v=<內容雜湊>：內容一改，網址就跟著改，
 * 使用者不會拿到舊版，沒改的檔案則能吃滿長期快取。
 *
 * 註：favicon 與 apple-touch-icon 刻意不加版本，瀏覽器對圖示本來就有
 * 自己的重抓節奏，網址保持穩定比較不會出怪事。
 */
const assetHashes = new Map();

async function collectAssetHashes(dir, rel) {
  if (!existsSync(dir)) return;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const key = `${rel}/${entry.name}`;
    if (entry.isDirectory()) {
      await collectAssetHashes(full, key);
      continue;
    }
    assetHashes.set(
      key,
      createHash('sha256').update(await readFile(full)).digest('hex').slice(0, 10),
    );
  }
}
await collectAssetHashes(join(STATIC_DIR, 'assets'), 'assets');

/** 把 `assets/...` 開頭（可含 ../ 前綴）的路徑補上 ?v=<雜湊> */
function assetVer(path) {
  const i = String(path).indexOf('assets/');
  if (i === -1) return path;
  const h = assetHashes.get(String(path).slice(i).split(/[?#]/)[0]);
  return h ? `${path}?v=${h}` : path;
}

/** 把一段 HTML 裡所有指向 assets/ 的 src/href/srcset 都補上版本查詢字串 */
function stampAssets(html) {
  return String(html)
    .replace(
      /((?:src|href)=")((?:\.\.\/)*assets\/[^"?#]+)(")/g,
      (_, a, url, c) => a + assetVer(url) + c,
    )
    .replace(/(srcset=")([^"]+)(")/g, (_, a, list, c) => {
      const stamped = list
        .split(',')
        .map((part) => {
          const t = part.trim();
          if (!t) return '';
          const sp = t.indexOf(' ');
          return sp === -1 ? assetVer(t) : assetVer(t.slice(0, sp)) + t.slice(sp);
        })
        .filter(Boolean)
        .join(', ');
      return a + stamped + c;
    });
}

/* ------------------------------------------------------- Markdown 設定 --- */

/**
 * marked 產生的是裸 <table>。用 CSS 讓 <table> 自己 overflow 會把 display
 * 換成 block，表格在無障礙樹裡就不再是表格（欄列關聯全部消失）。
 * 正確做法是包一層容器負責橫向捲動，table 保持 display: table。
 */
const baseTableRenderer = Renderer.prototype.table;
marked.use({
  renderer: {
    table(token) {
      const html = baseTableRenderer.call(this, token);
      return `<div class="table-scroll" tabindex="0" role="region" aria-label="表格，可橫向捲動">\n${html}</div>\n`;
    },
  },
});

/* ---------------------------------------------------------------- 工具 --- */

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 極簡 front matter 解析：只支援 `key: value`，值可用引號包住。 */
function parseFrontMatter(raw) {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: raw };

  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at === -1) continue;
    const key = line.slice(0, at).trim();
    let value = line.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return { data, body: m[2] };
}

/**
 * 取得檔案的「最後更新時間」。
 * 優先用 git 最後一次提交該檔案的時間（跨機器一致），git 不可用時退回檔案 mtime。
 */
function lastModified(filePath, fallbackMtime) {
  try {
    const out = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', filePath],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (out) return new Date(out);
  } catch {
    /* 尚未 git init、或該檔還沒進版控 —— 落到 mtime */
  }
  return fallbackMtime;
}

const TZ = 'Asia/Taipei';
const dateFmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const dateTimeFmt = new Intl.DateTimeFormat('zh-TW', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
});

/**
 * <time datetime>、JSON-LD 與 sitemap 都要機器可讀的 YYYY-MM-DD。
 *
 * 這裡必須跟 dateFmt 用同一個時區基準：published 是以 `T00:00:00+08:00`
 * 建構的，換算成 UTC 就是前一天 16:00，用 toISOString() 取日期會永遠退一天，
 * 造成畫面顯示 2026-08-02、機器可讀值卻是 2026-08-01。
 * en-CA 的輸出格式本身就是 YYYY-MM-DD，不需要再做字串替換。
 */
const isoFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

const fmtDate = (d) => dateFmt.format(d).replace(/\//g, '-');
const fmtDateTime = (d) => dateTimeFmt.format(d).replace(/\//g, '-');
const isoDate = (d) => isoFmt.format(d);

/* ------------------------------------------------------------ 讀取文章 --- */

async function loadPosts() {
  if (!existsSync(POSTS_DIR)) return [];
  const files = (await readdir(POSTS_DIR)).filter((f) => f.endsWith('.md'));

  const posts = [];
  for (const file of files) {
    const full = join(POSTS_DIR, file);
    const raw = await readFile(full, 'utf8');
    const { data, body } = parseFrontMatter(raw);
    const slug = file.replace(/\.md$/, '');

    if (String(data.draft).toLowerCase() === 'true') continue;

    // 發布日期：front matter 的 date 優先，否則從檔名前綴 YYYYMMDD 推得
    let published;
    if (data.date) {
      published = new Date(`${data.date}T00:00:00+08:00`);
    } else {
      const m = slug.match(/^(\d{4})(\d{2})(\d{2})/);
      published = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00+08:00`) : new Date();
    }

    const st = await stat(full);
    const updated = lastModified(full, st.mtime);

    posts.push({
      slug,
      file: full,
      title: data.title || slug,
      summary: data.summary || '',
      // SERP 專用：頁面上顯示的 title/summary 維持完整，這兩個欄位只餵給
      // <title> 與 meta description，讓搜尋結果不被截斷。
      seoTitle: data.seoTitle || '',
      metaDescription: data.metaDescription || '',
      author: data.author || site.author,
      tags: (data.tags || '').split(',').map((t) => t.trim()).filter(Boolean),
      published,
      updated,
      // 文章專屬 HERO 圖（未指定時沿用站台預設）
      heroImage: data.heroImage || '',
      heroAlt: data.heroAlt || '',
      heroWidth: data.heroWidth || '',
      heroHeight: data.heroHeight || '',
      heroCredit: data.heroCredit || '',
      // 長描述：alt 只留一句主旨，完整的資訊圖描述放進 figcaption
      heroCaption: data.heroCaption || '',
      heroSrcsetWidths: (data.heroSrcsetWidths || '')
        .split(',').map((n) => Number(n.trim())).filter((n) => n > 0),
      // 轉載資訊：原刊媒體、原文網址、原刊日期
      originalSite: data.originalSite || '',
      originalUrl: data.originalUrl || '',
      originalDate: data.originalDate || '',
      // 內文的圖片／連結一樣要吃到快取破壞的版本查詢字串
      html: stampAssets(marked.parse(body)),
    });
  }

  // 需求 7：最新的在前。
  // 同一天發布時，再比實際的更新時間，讓後來才加入的文章排在前面；
  // 兩者都相同才退回 slug（純粹為了排序穩定，不是有意義的順序）。
  posts.sort(
    (a, b) =>
      b.published - a.published ||
      b.updated - a.updated ||
      b.slug.localeCompare(a.slug),
  );
  return posts;
}

/* -------------------------------------------------------------- 樣板 --- */

/**
 * 決定某篇文章要用哪張 HERO 圖。
 * 文章 front matter 給了 heroImage 就用自己的，否則沿用站台預設圖。
 */
function heroFor(post) {
  if (!post?.heroImage) return site.hero;
  return {
    src: `assets/img/${post.heroImage}`,
    alt: post.heroAlt || post.title,
    caption: post.heroCaption || '',
    width: Number(post.heroWidth) || 1536,
    height: Number(post.heroHeight) || 1024,
    credit: post.heroCredit || '',   // 自有圖片：純文字標示，不涉授權條款
    srcsetWidths: post.heroSrcsetWidths?.length ? post.heroSrcsetWidths : undefined,
  };
}

/**
 * HERO 區。圖片等比例縮放，寬度由 CSS 限制在內容文字區寬度之內。
 *
 * up 是回到站台根目錄的相對前綴：首頁是 ''，文章頁是 '../'。
 * 少了它，文章頁會去要 /<slug>/assets/img/... —— Cloudflare Pages 對這種
 * 路徑會回 200 但內容是首頁 HTML，瀏覽器拿到 HTML 當圖片，靜靜地壞掉。
 */
function heroBlock({ eyebrow, title, lede, hero, up = '', zoom = false }) {
  const h = hero || site.hero;
  const src = escapeHtml(assetVer(up + h.src));

  // LCP 圖：CSS 把寬度壓在 42rem，手機只需要幾百 px 寬的來源。
  // 給 srcset 讓瀏覽器挑合適的尺寸，別再讓 375px 的螢幕下載 1920px 的原圖。
  const widths = h.srcsetWidths || site.hero?.srcsetWidths;
  const stem = String(h.src).replace(/\.[^./]+$/, '');
  const srcset = Array.isArray(widths) && widths.length
    ? escapeHtml(widths.map((w) => `${assetVer(`${up}${stem}-${w}.webp`)} ${w}w`).join(', '))
    : '';

  // 文章的主視覺常是資訊圖，手機上字太小，包一層連結讓人點開看原尺寸。
  const img = `<img
            class="hero__img"
            src="${src}"${
              srcset
                ? `
            srcset="${srcset}"
            sizes="(max-width: 44rem) 100vw, 42rem"`
                : ''
            }
            alt="${escapeHtml(h.alt)}"
            width="${h.width}"
            height="${h.height}"
            fetchpriority="high"
            decoding="async"
          />`;

  // 可及名稱交給內層 <img> 的 alt（accname 演算法）。
  // 以前這裡掛 aria-label="以原尺寸開啟主視覺圖片"，會整個蓋掉 alt，
  // 資訊圖的內容對輔助科技等於消失。詳細描述改由 figcaption 承接。
  const captionText = `${h.caption ? `${h.caption} ` : ''}點圖可放大（另開新分頁）。`;

  return `
      <section class="hero">
        <figure class="hero__figure">
          ${
            zoom
              ? `<a class="hero__zoom" href="${src}" target="_blank" rel="noopener noreferrer" aria-describedby="hero-caption">
            ${img}
          </a>
          <figcaption class="hero__hint" id="hero-caption">${escapeHtml(captionText)}</figcaption>`
              : img
          }
        </figure>
        <div class="hero__text">
          ${eyebrow ? `<p class="hero__eyebrow">${escapeHtml(eyebrow)}</p>` : ''}
          <h1 class="hero__title">${escapeHtml(title)}</h1>
          ${lede ? `<p class="hero__lede">${escapeHtml(lede)}</p>` : ''}
        </div>
      </section>`;
}

/**
 * 內容最後更新時間（所有文章的最大值），在載入文章後填入。
 *
 * 刻意「不」用建置當下的時間：那會讓每次 build 的產物都不同，
 * CI 於是每跑一次就把 docs/ 重新提交一次，本機永遠落後遠端。
 * 這個時間本來就該反映內容有沒有變，而不是建置動作跑過幾次。
 */
let contentUpdated = null;

/**
 * 需求 3：圖片出處標示放在 footer。
 * 標示的是「這一頁實際使用的那張 HERO 圖」——用了自己的圖就不該還掛著
 * CC BY 的授權聲明，那會變成錯誤標示。
 */
function footerBlock(hero) {
  const h = hero || site.hero;

  // 文件宣告 lang="zh-Hant-TW"，英文片段要各自標 lang="en"，
  // 否則螢幕閱讀器會用中文語音引擎去唸英文（WCAG 3.1.2）。
  const creator = h.creatorEn
    ? `${escapeHtml(h.creator)}（攝影：<span lang="en">${escapeHtml(h.creatorEn)}</span>）`
    : escapeHtml(h.creator);

  const creditBody = h.license
    ? `本頁 HERO 圖：<cite lang="en">${escapeHtml(h.workTitle)}</cite>，
            作者 ${creator}，
            取自 <a href="${escapeHtml(h.sourceUrl)}" lang="en" rel="license noopener noreferrer" target="_blank" aria-describedby="newtab-note">Wikimedia Commons</a>，
            依 <a href="${escapeHtml(h.licenseUrl)}" lang="en" rel="license noopener noreferrer" target="_blank" aria-describedby="newtab-note">${escapeHtml(h.license)}</a> 授權使用${h.modified ? '，本站已裁切調整' : '，未經修改'}。`
    : escapeHtml(h.credit || '本頁 HERO 圖由本站作者製作。');

  return `
    <footer class="footer">
      <div class="wrap">
        <section class="credit">
          <h2 class="credit__head">圖片出處</h2>
          <p class="credit__body">
            ${creditBody}
          </p>
        </section>
        <p class="footer__meta">
          <span>© ${contentUpdated ? contentUpdated.getFullYear() : new Date().getFullYear()} ${escapeHtml(site.author)}</span>
          ${
            contentUpdated
              ? `<span class="dot" aria-hidden="true">·</span>
          <span>內容最後更新 <time datetime="${isoDate(contentUpdated)}">${fmtDate(contentUpdated)}</time></span>`
              : ''
          }
        </p>
      </div>
    </footer>`;
}

/** 瀏覽次數的佔位符：– 只是視覺符號，唸出來沒有意義，交給 sr-only 說明。 */
function viewsSlot(slug) {
  return `<span data-views="${escapeHtml(slug)}" aria-live="polite"><span class="sr-only">尚未載入</span><span aria-hidden="true">–</span></span>`;
}

function layout({
  title, description, bodyClass, pageSlug, head = '', content, hero,
  canonicalOverride, noCanonical = false, assetBase,
}) {
  const counter = site.counter || {};
  // assetBase 讓 404 頁改用根層絕對路徑（它可能在任意深度被服務）
  const up = assetBase !== undefined ? assetBase : (pageSlug === 'site-home' ? '' : '../');
  // 404 頁走根層絕對路徑、且不隨版本變動（它不是效能敏感頁），其餘一律加 ?v=
  const ver = assetBase !== undefined ? ((p) => p) : assetVer;

  // 同一份內容會同時出現在 GitHub Pages 與 Cloudflare Pages 兩個網址，
  // 用 canonical 指定 Cloudflare 這個正式網址，避免被判定為重複內容。
  const selfUrl = origin
    ? `${origin}/${pageSlug === 'site-home' ? '' : `${pageSlug}/`}`
    : '';

  // 轉載文章把 canonical 指回原始出處，告訴搜尋引擎哪一份才是正本。
  // 這是同步發表的標準做法，也是對原刊媒體的基本禮貌。
  const canonical = noCanonical ? '' : (canonicalOverride || selfUrl);

  // 社群卡片：og:image 必須是絕對網址，相對路徑社群爬蟲抓不到。
  const h = hero || site.hero;
  const ogImage = origin ? `${origin}/${String(h.src).replace(/^\/+/, '')}` : '';
  const ogImageAlt = [...String(h.alt || '')].slice(0, 420).join('');
  const ogType = pageSlug === 'site-home' || noCanonical ? 'website' : 'article';

  return `<!doctype html>
<html lang="${escapeHtml(site.lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="author" content="${escapeHtml(site.author)}" />
<meta name="color-scheme" content="light dark" />
<meta property="og:type" content="${ogType}" />
<meta property="og:site_name" content="${escapeHtml(site.title)}" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:locale" content="zh_TW" />
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}" />
<meta property="og:image:width" content="${h.width}" />
<meta property="og:image:height" content="${h.height}" />
<meta property="og:image:alt" content="${escapeHtml(ogImageAlt)}" />` : ''}
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(description)}" />
${ogImage ? `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />
<meta name="twitter:image:alt" content="${escapeHtml(ogImageAlt)}" />` : ''}
${canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}" />\n<link rel="canonical" href="${escapeHtml(canonical)}" />` : ''}
<link rel="stylesheet" href="${ver(`${up}assets/css/site.css`)}" />
<link rel="icon" href="${up}assets/img/favicon.svg" type="image/svg+xml" />
<link rel="apple-touch-icon" href="${up}assets/img/icon-512.png" />
${head}
<script>
  window.__SITE__ = { counter: { apiBase: ${JSON.stringify(counter.apiBase || '')} } };
</script>
</head>
<body class="${bodyClass}" data-page-slug="${escapeHtml(pageSlug)}">
<a class="skip" href="#main">跳到主要內容</a>
<span id="newtab-note" class="sr-only">此連結會另開新分頁。</span>
<header class="topbar">
  <div class="wrap topbar__inner">
    <a class="topbar__brand" href="${up || './'}">${escapeHtml(site.title)}</a>
    <span class="topbar__views">
      <span class="sr-only">全站累計</span>本站瀏覽 ${viewsSlot('site-home')}
    </span>
  </div>
</header>
<main id="main" tabindex="-1">
${content}
</main>
${footerBlock(hero)}
<script src="${ver(`${up}assets/js/counter.js`)}" defer></script>
</body>
</html>
`;
}

/* ------------------------------------------------------- 首頁與文章頁 --- */

/** 需求 6：卡片是產生階段就寫進 HTML 的靜態內容。 */
function cardsBlock(posts) {
  if (!posts.length) {
    return '<p class="empty">目前還沒有文章。在 <code>content/posts/</code> 放一個 .md 檔，重新 build 就會出現在這裡。</p>';
  }

  return `<ul class="cards">
${posts
  .map((p) => {
    const sameDay = fmtDate(p.published) === fmtDate(p.updated);
    return `        <li class="card">
          <article>
            <h3 class="card__title"><a href="${escapeHtml(p.slug)}/">${escapeHtml(p.title)}</a></h3>
            ${p.summary ? `<p class="card__summary">${escapeHtml(p.summary)}</p>` : ''}
            ${
              p.tags.length
                ? `<p class="card__tags">${p.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</p>`
                : ''
            }
            <p class="card__meta">
              <span class="card__author">${escapeHtml(p.author)}</span>
              <span class="dot" aria-hidden="true">·</span>
              <span>發布 <time datetime="${isoDate(p.published)}">${fmtDate(p.published)}</time></span>
              ${
                sameDay
                  ? ''
                  : `<span class="dot" aria-hidden="true">·</span><span>更新 <time datetime="${isoDate(p.updated)}">${fmtDate(p.updated)}</time></span>`
              }
              <span class="dot" aria-hidden="true">·</span>
              <span class="card__views">瀏覽 ${viewsSlot(p.slug)}</span>
            </p>
          </article>
        </li>`;
  })
  .join('\n')}
      </ul>`;
}

function renderIndex(posts) {
  const newest = contentUpdated;

  const content = `${heroBlock({
    eyebrow: '長照機構經營筆記',
    title: site.title,
    lede: site.tagline,
  })}
      <div class="wrap">
        <section class="listing">
          <div class="listing__head">
            <h2>全部文章</h2>
            <p class="listing__meta">
              共 ${posts.length} 篇${
                newest
                  ? `
              <span class="dot" aria-hidden="true">·</span>
              內容最後更新 <time datetime="${isoDate(newest)}">${fmtDate(newest)}</time>`
                  : ''
              }
            </p>
          </div>
          ${cardsBlock(posts)}
        </section>
      </div>`;

  return layout({
    // 中文 SERP 大約只顯示 20-28 個全形字，title 用短版 tagline，
    // 長版留給 hero 的 lede（頁面上看得到的那一句）。
    title: `${site.title}｜${site.shortTagline || site.tagline}`,
    description: site.description,
    bodyClass: 'page-home',
    pageSlug: 'site-home',
    head: `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Blog',
      ...(origin ? { '@id': `${origin}/#blog`, url: `${origin}/` } : {}),
      name: site.title,
      description: site.description,
      inLanguage: 'zh-Hant-TW',
      author: { '@type': 'Person', name: site.author },
      publisher: { '@type': 'Person', name: site.author },
      // 首頁是文章索引頁，把 Blog → BlogPosting 的關聯明講出來。
      // 卡片本身仍是靜態 HTML，這裡只是額外的結構化訊號。
      blogPost: posts.map((p) => ({
        '@type': 'BlogPosting',
        headline: p.title,
        description: p.summary || undefined,
        ...(origin ? { url: `${origin}/${p.slug}/` } : {}),
        datePublished: isoDate(p.published),
        dateModified: isoDate(p.updated),
        author: { '@type': 'Person', name: p.author },
      })),
    })}</script>`,
    content,
    hero: site.hero,
  });
}

/**
 * 轉載聲明。有填 originalUrl 才會出現。
 *
 * 注意：這個 <a> 以前掛了 rel="canonical"。rel=canonical 只在 <link> 元素
 * （或 HTTP Link 標頭）上有定義，放在 <a> 上爬蟲不會處理，只是噪音，
 * 還會讓維護者以為 canonical 是靠它生效。真正的 canonical 在 <head>。
 */
function reprintNotice(post) {
  if (!post.originalUrl) return '';
  const site_ = post.originalSite || '原刊媒體';
  const when = post.originalDate ? `，${escapeHtml(post.originalDate)}` : '';
  return `
          <aside class="reprint">
            <p>
              本文原刊於<strong>${escapeHtml(site_)}</strong>${when}，
              作者為本站作者本人，經整理後同步發表於此。
              <a href="${escapeHtml(post.originalUrl)}" rel="external noopener noreferrer" target="_blank" aria-describedby="newtab-note">閱讀原文</a>。
            </p>
          </aside>`;
}

/** 水平互連：列出其餘文章，讓每篇文章不再是連結拓撲上的葉節點。 */
function otherPostsBlock(post, posts) {
  const others = (posts || []).filter((p) => p.slug !== post.slug);
  if (!others.length) return '';

  return `
          <nav class="related" aria-label="其他文章">
            <h2 class="related__head">其他文章</h2>
            <ul class="related__list">
${others
  .map(
    (p) => `              <li><a href="../${escapeHtml(p.slug)}/">${escapeHtml(p.title)}</a></li>`,
  )
  .join('\n')}
            </ul>
          </nav>`;
}

function renderPost(post, posts) {
  const sameDay = fmtDate(post.published) === fmtDate(post.updated);
  const hero = heroFor(post);

  // mainEntityOfPage / url 刻意與 <link rel=canonical> 同值：
  // 轉載文的正本在原刊媒體，結構化資料的訊號要跟 canonical 一致。
  const pageUrl = post.originalUrl || (origin ? `${origin}/${post.slug}/` : '');
  const heroUrl = origin ? `${origin}/${String(hero.src).replace(/^\/+/, '')}` : '';

  const content = `${heroBlock({
    eyebrow: post.tags[0] || '長照機構營運管理',
    title: post.title,
    lede: post.summary,
    hero,
    up: '../',
    zoom: true,
  })}
      <div class="wrap">
        <article class="post">
          <nav class="crumbs" aria-label="麵包屑">
            <a href="../">${escapeHtml(site.title)}</a>
            <span aria-hidden="true">›</span>
            <span aria-current="page">${escapeHtml(post.title)}</span>
          </nav>
          <p class="post__meta">
            <span class="post__author">作者：${escapeHtml(post.author)}</span>
            <span class="dot" aria-hidden="true">·</span>
            <span>發布 <time datetime="${isoDate(post.published)}">${fmtDate(post.published)}</time></span>
            ${
              sameDay
                ? ''
                : `<span class="dot" aria-hidden="true">·</span><span>最後更新 <time datetime="${isoDate(post.updated)}">${fmtDate(post.updated)}</time></span>`
            }
            <span class="dot" aria-hidden="true">·</span>
            <span>瀏覽 ${viewsSlot(post.slug)}</span>
          </p>
${reprintNotice(post)}
          <div class="prose">
${post.html}
          </div>
${otherPostsBlock(post, posts)}
          <p class="post__back"><a href="../"><span aria-hidden="true">←</span> 回到文章列表</a></p>
        </article>
      </div>`;

  const blogPosting = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.summary,
    inLanguage: 'zh-Hant-TW',
    ...(pageUrl
      ? { url: pageUrl, mainEntityOfPage: { '@type': 'WebPage', '@id': pageUrl } }
      : {}),
    ...(heroUrl
      ? {
          image: {
            '@type': 'ImageObject',
            url: heroUrl,
            width: Number(hero.width),
            height: Number(hero.height),
          },
        }
      : {}),
    datePublished: isoDate(post.published),
    dateModified: isoDate(post.updated),
    author: { '@type': 'Person', name: post.author },
    publisher: { '@type': 'Person', name: site.author },
    ...(post.tags.length ? { keywords: post.tags.join(', ') } : {}),
    ...(post.originalUrl
      ? { isBasedOn: post.originalUrl, creditText: post.originalSite || undefined }
      : {}),
  };

  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      {
        '@type': 'ListItem',
        position: 1,
        name: site.title,
        ...(origin ? { item: `${origin}/` } : {}),
      },
      // 最後一層依 Google 規範可省略 item
      { '@type': 'ListItem', position: 2, name: post.title },
    ],
  };

  return layout({
    title: post.seoTitle || `${post.title}｜${site.title}`,
    description: post.metaDescription || post.summary || site.description,
    bodyClass: 'page-post',
    pageSlug: post.slug,
    head: `<meta property="article:published_time" content="${isoDate(post.published)}" />
<meta property="article:modified_time" content="${isoDate(post.updated)}" />
<meta property="article:author" content="${escapeHtml(post.author)}" />
<script type="application/ld+json">${JSON.stringify(blogPosting)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbs)}</script>`,
    content,
    hero,
    canonicalOverride: post.originalUrl || '',
  });
}

/**
 * 404 頁。
 *
 * 沒有這一頁時，Cloudflare Pages 對找不到的路徑會回 200 + 首頁 HTML，
 * 而且那份 HTML 帶著指向首頁的 canonical —— 等於整個站有無限多個「有效」
 * 網址，Search Console 會堆滿「已檢索但未建立索引」與「重複網頁」。
 *
 * 這一頁可能在任意深度被服務（例如 /a/b/c），所以資產一律走根層絕對路徑，
 * 不能沿用 layout() 的 ../ 相對前綴。代價是 GitHub Pages 鏡像站（掛在
 * /ltc-blog/ 子路徑）的 404 會沒有樣式——canonical 目標是 Cloudflare，
 * 這個取捨可以接受，鏡像站本來就會正確回 404 狀態碼。
 */
function renderNotFound() {
  const content = `
      <div class="wrap">
        <section class="notfound">
          <h1>找不到這個頁面</h1>
          <p>網址可能打錯了，或這篇內容已經搬家。從首頁的文章列表找找看應該會比較快。</p>
          <p class="notfound__back"><a href="/">回到首頁</a></p>
        </section>
      </div>`;

  return layout({
    title: `找不到頁面｜${site.title}`,
    description: '找不到這個頁面。請回到首頁的文章列表。',
    bodyClass: 'page-404',
    pageSlug: 'not-found',
    // 404 頁不該宣告任何 canonical，也不該被索引
    noCanonical: true,
    assetBase: '/',
    head: '<meta name="robots" content="noindex, follow" />',
    content,
    hero: site.hero,
  });
}

/* --------------------------------------------------------------- 建置 --- */

const posts = await loadPosts();

contentUpdated = posts.length
  ? posts.reduce((a, p) => (p.updated > a ? p.updated : a), posts[0].updated)
  : null;

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });
await cp(STATIC_DIR, OUT_DIR, { recursive: true });

await writeFile(join(OUT_DIR, 'index.html'), renderIndex(posts), 'utf8');
await writeFile(join(OUT_DIR, '404.html'), renderNotFound(), 'utf8');

for (const post of posts) {
  const dir = join(OUT_DIR, post.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), renderPost(post, posts), 'utf8');
}

// sitemap / robots：Cloudflare Pages 與 GitHub Pages 都能直接吃
if (origin) {
  const urls = [
    // 首頁的 lastmod 要反映「所有文章的最新更新時間」。
    // posts[0] 只是發布日最新的那篇，不見得是最後被改動的那篇。
    { loc: `${origin}/`, lastmod: isoDate(contentUpdated || new Date()) },
    // canonical 指向站外的轉載文不進 sitemap：一邊說「正本在別人家」、
    // 一邊請 Google 索引自己這一份，只會換來「重複網頁」的排除項。
    ...posts
      .filter((p) => !p.originalUrl)
      .map((p) => ({ loc: `${origin}/${p.slug}/`, lastmod: isoDate(p.updated) })),
  ];
  await writeFile(
    join(OUT_DIR, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod></url>`)
      .join('\n')}\n</urlset>\n`,
    'utf8',
  );
  await writeFile(
    join(OUT_DIR, 'robots.txt'),
    `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`,
    'utf8',
  );
}

// GitHub Pages 預設會跑 Jekyll，會忽略底線開頭的檔案；停用它比較保險
await writeFile(join(OUT_DIR, '.nojekyll'), '', 'utf8');

/* ----------------------------------------------------- 產出後的自我檢查 --- */

/**
 * 檢查輸出的 HTML 裡每一個站內連結與資產，檔案是不是真的存在。
 *
 * 為什麼需要：文章頁在 /<slug>/ 底下，少寫 ../ 的相對路徑會指到
 * /<slug>/assets/...。Cloudflare Pages 對這種路徑回的是 200 + 首頁 HTML，
 * 不是 404 —— 瀏覽器拿到 HTML 當圖片，畫面靜靜地壞掉，沒有任何錯誤訊息。
 * 與其等人肉眼發現，不如在這裡直接讓建置失敗。
 */
async function checkLocalRefs(dir, base = dir) {
  const missing = [];

  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      missing.push(...(await checkLocalRefs(full, base)));
      continue;
    }
    if (!entry.name.endsWith('.html')) continue;

    const html = await readFile(full, 'utf8');

    // srcset 也要檢查。只掃 src/href 的話，srcset 裡漏放的檔案不會有任何警告，
    // 而瀏覽器挑到那個尺寸時圖片就是壞的。
    const refs = [];
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) refs.push(m[1]);
    for (const m of html.matchAll(/srcset="([^"]+)"/g)) {
      for (const part of m[1].split(',')) {
        const t = part.trim();
        if (!t) continue;
        const sp = t.indexOf(' ');
        refs.push(sp === -1 ? t : t.slice(0, sp));
      }
    }

    for (const ref of refs) {
      // 外部連結、資料 URI、錨點、協定相對路徑都不歸這裡管
      if (/^(https?:|data:|mailto:|tel:|#|\/\/)/.test(ref)) continue;

      const clean = ref.split(/[?#]/)[0];
      if (!clean) continue;

      const target = clean.endsWith('/')
        ? join(dirname(full), clean, 'index.html')
        : join(dirname(full), clean);

      if (!existsSync(target)) {
        missing.push({
          page: full.slice(base.length + 1).replace(/\\/g, '/'),
          ref,
        });
      }
    }
  }
  return missing;
}

const broken = await checkLocalRefs(OUT_DIR);
if (broken.length) {
  console.error(`\n✗ 有 ${broken.length} 個站內連結／資產找不到檔案：`);
  for (const b of broken) console.error(`  ${b.page}  →  ${b.ref}`);
  console.error('');
  process.exit(1);
}

console.log(`✓ 產生 ${posts.length} 篇文章 + 首頁 → ${resolve(OUT_DIR)}`);
for (const p of posts) {
  console.log(`  /${p.slug}/  發布 ${fmtDate(p.published)}  更新 ${fmtDate(p.updated)}`);
}
if (!origin) {
  console.log('  （site.config.json 的 siteUrl 還沒填，暫時略過 sitemap.xml 與 robots.txt）');
}
