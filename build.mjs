/**
 * 靜態網站產生器
 *
 * 對應需求：
 *  - 每篇文章輸出成 /<slug>/index.html，網址即 https://<站台>/<slug>
 *  - 首頁的文章卡片「直接寫死在 HTML 裡」，不靠 JavaScript 讀 JSON 生成（SEO）
 *  - 卡片與文章都標日期；更新日期由 git 最後提交時間自動帶入
 *  - 卡片依發布日期新到舊排序，新增 .md 檔即自動長出卡片
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  cp, mkdir, readFile, readdir, rm, stat, writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';

const ROOT = dirname(fileURLToPath(import.meta.url));
const POSTS_DIR = join(ROOT, 'content', 'posts');
const STATIC_DIR = join(ROOT, 'static');
const OUT_DIR = join(ROOT, 'docs'); // GitHub Pages 與 Cloudflare Pages 共用這個輸出目錄

const site = JSON.parse(await readFile(join(ROOT, 'site.config.json'), 'utf8'));

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

const fmtDate = (d) => dateFmt.format(d).replace(/\//g, '-');
const fmtDateTime = (d) => dateTimeFmt.format(d).replace(/\//g, '-');
/** <time datetime> 需要機器可讀格式 */
const isoDate = (d) => d.toISOString().slice(0, 10);

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
      // 轉載資訊：原刊媒體、原文網址、原刊日期
      originalSite: data.originalSite || '',
      originalUrl: data.originalUrl || '',
      originalDate: data.originalDate || '',
      html: marked.parse(body),
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
    width: Number(post.heroWidth) || 1536,
    height: Number(post.heroHeight) || 1024,
    credit: post.heroCredit || '',   // 自有圖片：純文字標示，不涉授權條款
  };
}

/** HERO 區。圖片等比例縮放，寬度由 CSS 限制在內容文字區寬度之內。 */
function heroBlock({ eyebrow, title, lede, hero }) {
  const h = hero || site.hero;
  return `
      <section class="hero">
        <figure class="hero__figure">
          <img
            class="hero__img"
            src="${escapeHtml(h.src)}"
            alt="${escapeHtml(h.alt)}"
            width="${h.width}"
            height="${h.height}"
            fetchpriority="high"
            decoding="async"
          />
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

  const creditBody = h.license
    ? `本頁 HERO 圖：<cite>${escapeHtml(h.workTitle)}</cite>，
            作者 ${escapeHtml(h.creator)}，
            取自 <a href="${escapeHtml(h.sourceUrl)}" rel="license noopener noreferrer" target="_blank">Wikimedia Commons</a>，
            依 <a href="${escapeHtml(h.licenseUrl)}" rel="license noopener noreferrer" target="_blank">${escapeHtml(h.license)}</a> 授權使用${h.modified ? '，本站已裁切調整' : '，未經修改'}。`
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

function layout({ title, description, bodyClass, pageSlug, head = '', content, hero, canonicalOverride }) {
  const counter = site.counter || {};
  const up = pageSlug === 'site-home' ? '' : '../';

  // 同一份內容會同時出現在 GitHub Pages 與 Cloudflare Pages 兩個網址，
  // 用 canonical 指定 Cloudflare 這個正式網址，避免被判定為重複內容。
  const origin = (site.siteUrl || '').replace(/\/+$/, '');
  const selfUrl = origin
    ? `${origin}/${pageSlug === 'site-home' ? '' : `${pageSlug}/`}`
    : '';

  // 轉載文章把 canonical 指回原始出處，告訴搜尋引擎哪一份才是正本。
  // 這是同步發表的標準做法，也是對原刊媒體的基本禮貌。
  const canonical = canonicalOverride || selfUrl;

  return `<!doctype html>
<html lang="${escapeHtml(site.lang)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="author" content="${escapeHtml(site.author)}" />
<meta name="color-scheme" content="light dark" />
<meta property="og:type" content="website" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(description)}" />
<meta property="og:locale" content="zh_TW" />
${canonical ? `<meta property="og:url" content="${escapeHtml(canonical)}" />\n<link rel="canonical" href="${escapeHtml(canonical)}" />` : ''}
<link rel="stylesheet" href="${up}assets/css/site.css" />
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>🏥</text></svg>" />
${head}
<script>
  window.__SITE__ = { counter: { apiBase: ${JSON.stringify(counter.apiBase || '')} } };
</script>
</head>
<body class="${bodyClass}" data-page-slug="${escapeHtml(pageSlug)}">
<a class="skip" href="#main">跳到主要內容</a>
<header class="topbar">
  <div class="wrap topbar__inner">
    <a class="topbar__brand" href="${up || './'}">${escapeHtml(site.title)}</a>
    <span class="topbar__views" title="全站瀏覽次數">
      本站瀏覽 <span data-views="site-home" aria-busy="true">–</span>
    </span>
  </div>
</header>
<main id="main">
${content}
</main>
${footerBlock(hero)}
<script src="${up}assets/js/counter.js" defer></script>
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
              <span class="card__views">瀏覽 <span data-views="${escapeHtml(p.slug)}" aria-busy="true">–</span></span>
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
    title: `${site.title}｜${site.tagline}`,
    description: site.description,
    bodyClass: 'page-home',
    pageSlug: 'site-home',
    head: `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'Blog',
      name: site.title,
      description: site.description,
      inLanguage: 'zh-Hant-TW',
      author: { '@type': 'Person', name: site.author },
    })}</script>`,
    content,
    hero: site.hero,
  });
}

/** 轉載聲明。有填 originalUrl 才會出現。 */
function reprintNotice(post) {
  if (!post.originalUrl) return '';
  const site_ = post.originalSite || '原刊媒體';
  const when = post.originalDate ? `，${escapeHtml(post.originalDate)}` : '';
  return `
          <aside class="reprint">
            <p>
              本文原刊於<strong>${escapeHtml(site_)}</strong>${when}，
              作者為本站作者本人，經整理後同步發表於此。
              <a href="${escapeHtml(post.originalUrl)}" rel="canonical noopener noreferrer" target="_blank">閱讀原文</a>。
            </p>
          </aside>`;
}

function renderPost(post) {
  const sameDay = fmtDate(post.published) === fmtDate(post.updated);
  const hero = heroFor(post);

  const content = `${heroBlock({
    eyebrow: post.tags[0] || '長照機構營運管理',
    title: post.title,
    lede: post.summary,
    hero,
  })}
      <div class="wrap">
        <article class="post">
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
            <span>瀏覽 <span data-views="${escapeHtml(post.slug)}" aria-busy="true">–</span></span>
          </p>
${reprintNotice(post)}
          <div class="prose">
${post.html}
          </div>
          <p class="post__back"><a href="../">← 回到文章列表</a></p>
        </article>
      </div>`;

  return layout({
    title: `${post.title}｜${site.title}`,
    description: post.summary || site.description,
    bodyClass: 'page-post',
    pageSlug: post.slug,
    head: `<script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.summary,
      inLanguage: 'zh-Hant-TW',
      datePublished: isoDate(post.published),
      dateModified: isoDate(post.updated),
      author: { '@type': 'Person', name: post.author },
      ...(post.originalUrl
        ? { isBasedOn: post.originalUrl, creditText: post.originalSite || undefined }
        : {}),
    })}</script>`,
    content,
    hero,
    canonicalOverride: post.originalUrl || '',
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

for (const post of posts) {
  const dir = join(OUT_DIR, post.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), renderPost(post), 'utf8');
}

// sitemap / robots：Cloudflare Pages 與 GitHub Pages 都能直接吃
const origin = (site.siteUrl || '').replace(/\/+$/, '');
if (origin) {
  const urls = [
    { loc: `${origin}/`, lastmod: posts.length ? isoDate(posts[0].updated) : isoDate(new Date()) },
    ...posts.map((p) => ({ loc: `${origin}/${p.slug}/`, lastmod: isoDate(p.updated) })),
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

console.log(`✓ 產生 ${posts.length} 篇文章 + 首頁 → ${resolve(OUT_DIR)}`);
for (const p of posts) {
  console.log(`  /${p.slug}/  發布 ${fmtDate(p.published)}  更新 ${fmtDate(p.updated)}`);
}
if (!origin) {
  console.log('  （site.config.json 的 siteUrl 還沒填，暫時略過 sitemap.xml 與 robots.txt）');
}
