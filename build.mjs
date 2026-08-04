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

/**
 * 文件宣告 lang="zh-Hant-TW"，body 內的英文片段要各自標 lang="en"，
 * 否則中文語音引擎會把 Know-how、Email、SOP 當中文拼讀（WCAG 3.1.2）。
 *
 * 文案全部經 escapeHtml() 輸出，作者沒辦法在設定檔裡自己加標記，
 * 只好在樣板這一層補。順序固定是 markEn(escapeHtml(x))：先跳脫再插標籤，
 * 反過來會把自己插入的 < > 也跳脫掉。
 *
 * 只能用在「元素內容」，不可用在屬性值（alt、title⋯）——屬性裡不能放標籤。
 */
const EN_WORDS = /(Know-how|know-how|Email|LINE|SOP|QR Code)/g;
const markEn = (s) => String(s ?? '').replace(EN_WORDS, '<span lang="en">$1</span>');

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
  // 站台層級的預設主圖已移除，沒設 heroImage 就是沒有主圖
  if (!post?.heroImage) return null;

  const widths = post.heroSrcsetWidths?.length ? post.heroSrcsetWidths : undefined;
  // stem 是「不含尺寸後綴與副檔名」的檔名主幹，srcset 的候選檔名都由它組出來。
  const stem = `assets/img/${post.heroImage}`.replace(/\.[^./]+$/, '');
  // src 直接指向最大的變體，不再另外留一個內容相同的無後綴檔。
  // srcset 一旦使用 w 描述符，符合規範的瀏覽器就不會把 src 納入候選，
  // 那個檔案永遠不會被下載，留著只是讓 static/ 多背一份重複資料。
  const src = widths ? `${stem}-${Math.max(...widths)}.webp` : `assets/img/${post.heroImage}`;

  return {
    src,
    stem,
    alt: post.heroAlt || post.title,
    caption: post.heroCaption || '',
    width: Number(post.heroWidth) || 1536,
    height: Number(post.heroHeight) || 1024,
    credit: post.heroCredit || '',   // 自有圖片：純文字標示，不涉授權條款
    srcsetWidths: widths,
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
  const h = hero;

  // 沒有主圖就只輸出文字區。站台層級的預設主圖已移除（那是一張沒人引用的
  // CC BY 素材），文章若沒設 heroImage，就是單純沒有主視覺，不該硬湊一張。
  if (!h?.src) {
    return `
      <section class="hero">
        <div class="hero__text">
          ${eyebrow ? `<p class="hero__eyebrow">${escapeHtml(eyebrow)}</p>` : ''}
          <h1 class="hero__title">${escapeHtml(title)}</h1>
          ${lede ? `<p class="hero__lede">${escapeHtml(lede)}</p>` : ''}
        </div>
      </section>`;
  }

  const src = escapeHtml(assetVer(up + h.src));

  // LCP 圖：CSS 把寬度壓在 42rem，手機只需要幾百 px 寬的來源。
  // 給 srcset 讓瀏覽器挑合適的尺寸，別再讓 375px 的螢幕下載原圖。
  const widths = h.srcsetWidths;
  const stem = h.stem || String(h.src).replace(/\.[^./]+$/, '');
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
function footerBlock(hero, up = '') {
  // hero 傳 null＝這一頁沒有主圖（關於我、聯絡方式⋯），
  // 就整段不輸出圖片出處。沒有圖卻掛出處是錯誤標示。
  let creditSection = '';

  if (hero) {
    const h = hero;

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

    creditSection = `
        <section class="credit">
          <h2 class="credit__head">圖片出處</h2>
          <p class="credit__body">
            ${creditBody}
          </p>
        </section>`;
  }

  // 次要導覽。全站的內部連結原本只有頁首那一組，每頁的連結拓撲完全一樣，
  // 沒有任何主題相關性訊號；footer 補一組同樣的入口，讓長頁面的讀者
  // 捲到底時不必再回到頁首，也讓每一頁多出一批可被爬取的站內連結。
  const navItems = Array.isArray(site.nav) ? site.nav : [];
  const footerNav = navItems.length
    ? `
        <nav class="footer__nav" aria-label="次要導覽">
          <ul>
            <li><a href="${up || './'}">首頁</a></li>
${navItems
  .map((n) => `            <li><a href="${up}${escapeHtml(n.id)}/">${escapeHtml(n.label)}</a></li>`)
  .join('\n')}
          </ul>
        </nav>`
    : '';

  return `
    <footer class="footer">
      <div class="wrap">${creditSection}${footerNav}
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

/**
 * 瀏覽次數的佔位符：– 只是視覺符號，唸出來沒有意義，交給 sr-only 說明。
 *
 * 刻意不掛 aria-live：counter.js 會在同一個 tick 內把整頁的節點一次 paint 完，
 * 首頁與 /articles/ 各有三個以上的佔位符，螢幕閱讀器會在使用者剛開始讀頁面時
 * 被連續打斷朗讀好幾次純數字。aria-live 是用來通知「使用者操作後的變化」，
 * 頁面載入時的初次填值不屬於這個情境。
 */
function viewsSlot(slug) {
  return `<span data-views="${escapeHtml(slug)}"><span class="sr-only">尚未載入</span><span aria-hidden="true">–</span></span>`;
}

function layout({
  title, description, bodyClass, pageSlug, head = '', content, hero,
  canonicalOverride, noCanonical = false, assetBase, ogType: ogTypeIn,
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
  //
  // hero 可能是「有出處說明但沒有圖」的物件（首頁就是這樣），
  // 直接 hero || site.hero 會拿到一個沒有 src 的物件，輸出 /undefined。
  // 沒有可用主圖時一律退回專門做的社群卡片 assets/img/og-card.jpg：
  // 1200×630 是各平台的建議尺寸，也不會誤用文章頁才該掛出處的 CC BY 素材。
  const h = (hero && hero.src) ? hero : site.ogImage;
  const ogImage = (origin && h && h.src)
    ? `${origin}/${String(h.src).replace(/^\/+/, '')}`
    : '';
  const ogImageAlt = [...String(h?.alt || '')].slice(0, 420).join('');

  // og:type 依規範，article 必須伴隨 article:published_time／modified_time，
  // 那兩個標籤只有 renderPost 會輸出。介紹頁與索引頁的 JSON-LD 也是 WebPage，
  // 宣告成 article 只會讓 OG 與結構化資料互相打架，一律由呼叫端指定 website。
  const ogType = ogTypeIn || (pageSlug === 'site-home' || noCanonical ? 'website' : 'article');

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
<link rel="icon" href="${up}favicon.ico" sizes="32x32" />
<link rel="apple-touch-icon" href="${up}assets/img/icon-512.png" />
${origin ? `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(site.title)}" href="${up}feed.xml" />` : ''}
${head}
<script>
  window.__SITE__ = { counter: { apiBase: ${JSON.stringify(counter.apiBase || '')} } };
</script>
</head>
<body class="${bodyClass}" data-page-slug="${escapeHtml(pageSlug)}">
<a class="skip" href="#main">跳到主要內容</a>
<header class="topbar">
  <div class="wrap topbar__inner">
    <!-- aria-describedby 是全文件的 id 參照，位置不影響引用；
         但放在 <body> 直屬層會落在所有 landmark 之外，axe 的 region 規則
         會對每一頁報一個 violation，所以收進 header 裡。 -->
    <span id="newtab-note" class="sr-only">此連結會另開新分頁。</span>
    <a class="topbar__brand" href="${up || './'}">${escapeHtml(site.title)}</a>
    ${navBlock(up, pageSlug)}
    <span class="topbar__views">
      <span class="sr-only">全站累計</span>本站瀏覽 ${viewsSlot('site-home')}
    </span>
  </div>
</header>
<main id="main" tabindex="-1">
${content}
</main>
${footerBlock(hero, up)}
<script src="${ver(`${up}assets/js/counter.js`)}" defer></script>
${pageSlug === 'results' ? `<script src="${ver(`${up}assets/js/stats.js`)}" defer></script>` : ''}
${pageSlug === 'contact' ? `<script src="${ver(`${up}assets/js/email.js`)}" defer></script>` : ''}
${bodyClass === 'page-post' || bodyClass === 'page-home' ? `<script src="${ver(`${up}assets/js/share.js`)}" defer></script>` : ''}
</body>
</html>
`;
}

/* ------------------------------------------------------- 首頁與文章頁 --- */

/** 需求 6：卡片是產生階段就寫進 HTML 的靜態內容。 */
// titleLevel：卡片上方有 h2（首頁的「最新文章」）時用 3；
// 沒有的話（/articles/ 只有 h1）要用 2，否則從 h1 跳到 h3。
// eagerFirst：第一張卡片的縮圖是不是首屏的 LCP 元素。
// /articles/ 的第一張卡片在 375px 下 top=198，確定在首屏，要 eager 加高優先權；
// 首頁的卡片在 top 1123px，lazy 才是對的，所以預設 false。
function cardsBlock(posts, up = '', titleLevel = 3, eagerFirst = false) {
  if (!posts.length) {
    return '<p class="empty">目前還沒有文章。在 <code>content/posts/</code> 放一個 .md 檔，重新 build 就會出現在這裡。</p>';
  }

  return `<ul class="cards">
${posts
  .map((p, idx) => {
    const sameDay = fmtDate(p.published) === fmtDate(p.updated);
    const h = heroFor(p);
    const eager = eagerFirst && idx === 0;

    // 卡片縮圖。up 是回站台根目錄的前綴：首頁 ''、/articles/ 是 '../'。
    // 文章沒有主圖時就不輸出縮圖，卡片只有文字。
    const thumbWidths = h?.srcsetWidths;
    const thumbStem = h?.stem || (h?.src ? String(h.src).replace(/\.[^./]+$/, '') : '');
    const thumbSrcset = Array.isArray(thumbWidths) && thumbWidths.length
      ? escapeHtml(thumbWidths.map((w) => `${assetVer(`${up}${thumbStem}-${w}.webp`)} ${w}w`).join(', '))
      : '';

    // alt 留空：縮圖對這張卡而言是裝飾，內容由緊接著的標題承載。
    // 放 alt 會讓螢幕閱讀器在每個標題前先念一整段圖片描述。
    // 連結重複指向同一篇，用 tabindex="-1" + aria-hidden 避免多一個 Tab 停留點。
    const thumb = h?.src
      ? `<a class="card__thumb" href="${escapeHtml(up + p.slug)}/" tabindex="-1" aria-hidden="true">
              <img
                src="${escapeHtml(assetVer(up + h.src))}"${thumbSrcset ? `
                srcset="${thumbSrcset}"
                sizes="(max-width: 46rem) calc(100vw - 2rem), 27rem"` : ''}
                alt=""
                width="${h.width}"
                height="${h.height}"
                ${eager ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"'}
              />
            </a>`
      : '';

    return `        <li class="card">
          <article>
            ${thumb}
            <h${titleLevel} class="card__title"><a href="${escapeHtml(up + p.slug)}/">${escapeHtml(p.title)}</a></h${titleLevel}>
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

/**
 * 首頁的信任區塊：人像、定位、專業背景。
 *
 * 訪客通常在幾秒內決定要不要繼續看，所以首頁開頭放的是「你是誰、做什麼、
 * 能帶來什麼」，而不是文章列表。文章索引往下移。
 *
 * h1 同時含人名與領域：人名建立信任、領域承接搜尋關鍵字，兩者都要。
 * 副標吃的是 profile.headline（領域），不是 profile.field（品牌標語）——
 * 標語裡沒有任何會被搜尋的詞，掛在 h1 上等於浪費全頁最強的主題訊號。
 * 標語本身沒有刪掉，只是移到 h1 底下自成一段。
 */
function profileBlock() {
  const p = site.profile;
  if (!p) return '';

  const src = escapeHtml(assetVer(p.photo));
  const small = p.photoSmall ? escapeHtml(assetVer(p.photoSmall)) : '';
  const size = Number(p.photoSize) || 560;

  return `
      <section class="profile">
        <div class="wrap profile__inner">
          <img
            class="profile__photo"
            src="${src}"${
              small
                ? `
            srcset="${small} 280w, ${src} ${size}w"
            sizes="(max-width: 46rem) 9.5rem, 13rem"`
                : ''
            }
            alt="${escapeHtml(p.photoAlt || p.name)}"
            width="${size}"
            height="${size}"
            fetchpriority="high"
            decoding="async"
          />
          <div class="profile__text">
            <h1 class="profile__name">
              ${escapeHtml(p.name)}<span class="profile__field">${escapeHtml(p.headline || p.field || '')}</span>
            </h1>
            ${p.field ? `<p class="profile__tagline">${clauses(p.field)}</p>` : ''}
            ${p.role ? `<p class="profile__role">${escapeHtml(p.role)}</p>` : ''}
            ${p.positioning ? `<p class="profile__lede">${markEn(escapeHtml(p.positioning))}</p>` : ''}
${shareBlock({ url: `${origin}/`, title: site.title, variant: 'profile' })}
          </div>
        </div>
      </section>`;
}

/**
 * 頁首導覽。每一項都是獨立頁面（/about/、/services/⋯），不是錨點。
 * up 是回站台根目錄的相對前綴：首頁 ''、其餘頁面 '../'。
 * 目前所在的那一頁標成 aria-current="page"。
 */
function navBlock(up, currentSlug) {
  const items = site.nav;
  if (!Array.isArray(items) || !items.length) return '';

  return `<nav class="topnav" aria-label="主要導覽">
      <ul>
${items
  .map((n) => {
    const here = n.id === currentSlug;
    return `        <li><a href="${up}${escapeHtml(n.id)}/"${here ? ' aria-current="page"' : ''}>${escapeHtml(n.label)}</a></li>`;
  })
  .join('\n')}
      </ul>
    </nav>`;
}

/**
 * 卡片式區塊（關於我、我的服務）。內容全部來自 site.config.json。
 * heading 傳空字串就不輸出標題——首頁用得到：那裡只要三張卡，
 * 不需要再壓一個「關於我」大標把版面撐開。
 */
function cardSection(id, heading, items, { center = false, intro = [] } = {}) {
  if (!Array.isArray(items) || !items.length) return '';

  // 沒有區塊標題時，卡片標題要升到 h2，否則會從 h1 直接跳到 h3。
  // 跳階會讓螢幕閱讀器的標題導覽出現斷層，也是 SEO 檢測的扣分項。
  const lvl = heading ? 3 : 2;

  const introBlock = Array.isArray(intro) && intro.length
    ? `<div class="section__intro">
${intro.map((t) => `            <p>${markEn(escapeHtml(t))}</p>`).join('\n')}
          </div>`
    : '';

  // meta：卡片底下的「適用機構類型／常見合作方式／產出物」。
  // 用 <dl> 而不是再多一層標題——這些是同一張卡的屬性，不是新的章節，
  // 掛成 h4 只會讓標題大綱多出九個沒有導覽價值的節點。
  const metaList = (w) =>
    Array.isArray(w.meta) && w.meta.length
      ? `
              <dl class="tile__meta">
${w.meta
  .map(
    (m) => `                <dt>${markEn(escapeHtml(m.label))}</dt>
                <dd>${markEn(escapeHtml(m.value))}</dd>`,
  )
  .join('\n')}
              </dl>`
      : '';

  return `
      <section class="section" id="${escapeHtml(id)}">
        <div class="wrap">
          ${heading ? `<h2 class="section__head${center ? ' section__head--center' : ''}">${escapeHtml(heading)}</h2>` : ''}
          ${introBlock}
          <ul class="tiles">
${items
  .map(
    (w) => `            <li class="tile">
              <h${lvl} class="tile__title">${markEn(escapeHtml(w.title))}</h${lvl}>
              ${w.detail ? `<p class="tile__detail">${markEn(escapeHtml(w.detail))}</p>` : ''}${metaList(w)}
            </li>`,
  )
  .join('\n')}
          </ul>
        </div>
      </section>`;
}

/**
 * 頁尾的行動呼籲。介紹頁原本是連結拓撲上的死路——進來之後除了頁首導覽
 * 沒有任何出口，也沒有把「看完服務就該來談合作」這條主題關聯講給搜尋引擎聽。
 * 錨點文字一律用具體的頁面名稱，不用「這裡」「更多」。
 */
function ctaBlock(cta, up = '../') {
  if (!cta?.href || !cta?.label) return '';

  return `
      <section class="section section--cta">
        <div class="wrap">
          <p class="cta">
            ${cta.text ? `<span class="cta__text">${escapeHtml(cta.text)}</span>` : ''}
            <a class="cta__link" href="${up}${escapeHtml(cta.href)}/">${escapeHtml(cta.label)}<span aria-hidden="true"> →</span></a>
          </p>
        </div>
      </section>`;
}

/**
 * 合作成果。
 * 刻意在沒有資料時輸出「待補」而不是編一個看起來合理的數字——
 * 這一區會被潛在客戶與公部門當成事實查看，寧可空著也不能捏造。
 */
/**
 * 把句子依全形逗號切成子句，每個子句包成 inline-block。
 *
 * 中文可以在任意字元間斷行，長句子常常斷在詞語中間很難看。
 * 包成 inline-block 之後，換行點會優先落在逗號後面；
 * 寬度夠時整句仍然併成完整一行。
 */
function clauses(text) {
  return String(text)
    .split(/(?<=，)/)
    .filter(Boolean)
    .map((c) => `<span>${escapeHtml(c)}</span>`)
    .join('');
}

/**
 * 顧問成果。
 *
 * 數字用 data-count-to 交給 JS 做捲到才跑的動畫，但 HTML 裡本來就寫著
 * 最終值——沒有 JS、或使用者偏好減少動態時，看到的仍是正確數字。
 */
function resultsBlock() {
  const r = site.resultsPage;
  if (!r) {
    return `
      <section class="section" id="results">
        <div class="wrap">
          <p class="placeholder">此區待補。</p>
        </div>
      </section>`;
  }

  const c = r.client || {};

  return `
      <section class="section" id="results">
        <div class="wrap">
          <h2 class="section__head">${escapeHtml(r.clientHeading || '合作客戶與輔導範圍')}</h2>
          <article class="client">
            <p class="client__name">${escapeHtml(c.name || '')}</p>
            ${
              c.role
                ? `<p class="client__role"><span class="client__role-label">${escapeHtml(c.roleLabel || '合作角色')}</span>${escapeHtml(c.role)}</p>`
                : ''
            }
            ${c.summary ? `<p class="client__summary">${escapeHtml(c.summary)}</p>` : ''}
          </article>

          ${
            Array.isArray(r.achievements) && r.achievements.length
              ? `<h3 class="subhead">${escapeHtml(r.achievementsHeading || '輔導成效')}</h3>
          <ul class="checks">
${r.achievements.map((t) => `            <li>${markEn(escapeHtml(t))}</li>`).join('\n')}
          </ul>`
              : ''
          }

          ${
            Array.isArray(r.work) && r.work.length
              ? `<h3 class="subhead">${escapeHtml(r.workHeading || '我的工作內容')}</h3>
          <ul class="chips">
${r.work.map((t) => `            <li>${markEn(escapeHtml(t))}</li>`).join('\n')}
          </ul>`
              : ''
          }

          ${
            Array.isArray(r.belief) && r.belief.length
              ? `<h3 class="subhead">${escapeHtml(r.beliefHeading || '我相信')}</h3>
          <blockquote class="belief">
${r.belief.map((t) => `            <p>${clauses(t)}</p>`).join('\n')}
          </blockquote>`
              : ''
          }

          ${
            Array.isArray(r.stats) && r.stats.length
              ? `<ul class="stats">
${r.stats
  .map(
    (s) => `            <li class="stat">
              <p class="stat__value" data-count-to="${Number(s.value)}" data-suffix="${escapeHtml(s.suffix || '')}">${Number(s.value).toLocaleString('en-US')}${escapeHtml(s.suffix || '')}</p>
              <p class="stat__label">${escapeHtml(s.label)}</p>
            </li>`,
  )
  .join('\n')}
          </ul>`
              : ''
          }

          ${r.closing ? `<p class="motto">${clauses(r.closing)}</p>` : ''}
        </div>
      </section>${ctaBlock(r.cta)}`;
}

/** 聯絡方式。同樣不編造——沒填就顯示待補。 */
function contactBlock(heading = '', up = '../') {
  const c = site.contact || {};
  const items = Array.isArray(c.items) ? c.items : [];
  const q = c.qr;

  // QR 圖在 375px 下 top=362、面積是次大元素的 2.9 倍，是這一頁的 LCP 元素，
  // 不能 lazy。也刻意不加 fetchpriority——在較矮的手機它會落到首屏外。
  //
  // QR 只是圖，alt 描述的是「這是什麼圖」而不是裡面編碼的帳號：
  // 螢幕閱讀器使用者、只有一台桌機的訪客、鍵盤使用者都拿不到聯絡途徑。
  // contact.qr.href 有值時就把說明文字換成真的可以按的連結（WCAG 1.1.1）。
  const qrHref = typeof q?.href === 'string' && q.href.trim() ? q.href.trim() : '';
  const qrNote = q?.note
    ? qrHref
      ? `<a class="qr__note" href="${escapeHtml(qrHref)}"${/^https?:/.test(qrHref) ? ' target="_blank" rel="noopener noreferrer" aria-describedby="newtab-note"' : ''}>${markEn(escapeHtml(q.note))}</a>`
      : `<span class="qr__note">${markEn(escapeHtml(q.note))}</span>`
    : '';

  const qrBlock = q?.image
    ? `<figure class="qr">
            <img
              class="qr__img"
              src="${escapeHtml(assetVer(up + q.image))}"
              alt="${escapeHtml(q.alt || '')}"
              width="${Number(q.size) || 600}"
              height="${Number(q.size) || 600}"
              decoding="async"
            />
            <figcaption class="qr__caption">
              <span class="qr__label">${markEn(escapeHtml(q.label || 'LINE'))}</span>
              ${qrNote}
            </figcaption>
          </figure>`
    : '';

  const body = items.length
    ? `<ul class="contact">
${items
  .map(
    (i) => {
      // protect: true 的項目（Email）不以明文寫進 HTML。
      // 收信箱的爬蟲絕大多數只是拿 \S+@\S+ 這種正規式掃原始碼，
      // 原文改成 base64 就掃不到；JS 載入後再還原成可點的 mailto。
      // 沒有 JS 時顯示人類看得懂、正規式抓不到的替代寫法。
      const value = i.protect
        ? `<span class="contact__value" data-email="${Buffer.from(String(i.value), 'utf8').toString('base64')}">${escapeHtml(
            String(i.value).replace('@', '（at）').replace(/\.(?=[^.]*$)/, '（dot）'),
          )}</span>`
        : i.href
          ? `<a class="contact__value" href="${escapeHtml(i.href)}"${/^https?:/.test(i.href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${escapeHtml(i.value)}</a>`
          : `<span class="contact__value">${escapeHtml(i.value)}</span>`;

      return `            <li class="contact__item">
              <span class="contact__label">${markEn(escapeHtml(i.label))}</span>
              ${value}
            </li>`;
    },
  )
  .join('\n')}
          </ul>`
    : `<p class="placeholder">此區待補：希望公開的聯絡方式（Email、電話、LINE 或表單連結）。<br />確認後填入 <code>site.config.json</code> 的 <code>contact.items</code>。</p>`;

  // 合作流程／可洽談的主題範圍／回覆時間。
  // 這一頁原本只有一句話加三筆聯絡資料（可見文字 430 字元），
  // 中文站台這種篇幅很容易落進 Search Console 的「已檢索－尚未建立索引」。
  const p = site.contactPage || {};
  const sections = Array.isArray(p.sections) && p.sections.length
    ? `
      <section class="section section--howto">
        <div class="wrap">
${p.sections
  .map(
    (s) => `          <div class="howto">
            <h2 class="section__head">${markEn(escapeHtml(s.heading))}</h2>
            <ul class="howto__list">
${(s.items || []).map((t) => `              <li>${markEn(escapeHtml(t))}</li>`).join('\n')}
            </ul>
          </div>`,
  )
  .join('\n')}
        </div>
      </section>`
    : '';

  return `
      <section class="section section--contact" id="contact">
        <div class="wrap">
          ${heading ? `<h2 class="section__head">${escapeHtml(heading)}</h2>` : ''}
          ${c.intro ? `<p class="section__lede">${markEn(escapeHtml(c.intro))}</p>` : ''}
          <div class="contact__grid">
            ${body}
            ${qrBlock}
          </div>
        </div>
      </section>${sections}${ctaBlock(p.cta, up)}`;
}

/* ------------------------------------------------------- 結構化資料 --- */

/**
 * 全站共用的實體識別碼。
 *
 * 以前每個 Person 都是獨立的 {"@type":"Person","name":"顏和平"}，
 * 八個頁面拆出七個沒有識別碼的孤立節點，搜尋引擎沒有依據把它們合併成
 * 同一個人。改成「完整節點只在 /about/ 出現一次，其餘全部用 @id 參照」。
 */
const PERSON_ID = origin ? `${origin}/about/#person` : '';
const WEBSITE_ID = origin ? `${origin}/#website` : '';

/** 精簡引用：只有 @id，指向 /about/ 的完整節點。 */
function personRef() {
  return PERSON_ID ? { '@id': PERSON_ID } : { '@type': 'Person', name: site.author };
}

/**
 * Person 實體。full=true 時輸出完整節點（只有 /about/ 該用）。
 *
 * sameAs 只有在站主提供並確認過外部網址時才輸出——這個欄位是要告訴
 * 搜尋引擎「這個人在別的權威來源也是同一個人」，填錯或憑空猜測會把
 * 兩個不同的人綁在一起，比不填更糟。目前沒有取得，整個欄位不輸出。
 */
function personNode(full = false) {
  if (!full) return personRef();

  const p = site.profile || {};
  const occupations = Array.isArray(site.journey?.steps)
    ? site.journey.steps.map((s) => ({
        '@type': 'Occupation',
        name: s.role,
        description: s.detail,
      }))
    : [];

  return {
    '@type': 'Person',
    ...(PERSON_ID ? { '@id': PERSON_ID } : {}),
    name: site.author,
    ...(origin ? { url: `${origin}/about/` } : {}),
    ...(p.role ? { jobTitle: p.role } : {}),
    ...(Array.isArray(p.knowsAbout) && p.knowsAbout.length
      ? { knowsAbout: p.knowsAbout }
      : {}),
    ...(origin && p.photo ? { image: `${origin}/${p.photo}` } : {}),
    ...(occupations.length ? { hasOccupation: occupations } : {}),
    ...(Array.isArray(p.sameAs) && p.sameAs.length ? { sameAs: p.sameAs } : {}),
  };
}

/** 全站唯一的 WebSite 節點。每頁的主要節點都用 isPartOf 掛回來。 */
function websiteNode() {
  if (!origin) return null;
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    url: `${origin}/`,
    name: site.title,
    ...(site.shortTagline ? { alternateName: site.shortTagline } : {}),
    inLanguage: 'zh-Hant-TW',
    publisher: personRef(),
  };
}

/**
 * 麵包屑。items 每一筆是 { name, url（絕對）, href（頁面相對）}。
 * 最後一層依 Google 規範可省略 item，但只有一層時仍要給，否則整串沒有網址。
 */
function breadcrumbLd(items, id) {
  return {
    '@type': 'BreadcrumbList',
    ...(id ? { '@id': id } : {}),
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.name,
      ...(it.url && (items.length === 1 || i < items.length - 1) ? { item: it.url } : {}),
    })),
  };
}

/** 可見麵包屑。只有一層時不輸出——「首頁 ›」自己一項沒有導覽價值。 */
function crumbsNav(items) {
  if (!Array.isArray(items) || items.length < 2) return '';
  const parts = items.map((it, i) =>
    i === items.length - 1
      ? `<span aria-current="page">${escapeHtml(it.name)}</span>`
      : `<a href="${escapeHtml(it.href)}">${escapeHtml(it.name)}</a>
            <span aria-hidden="true">›</span>`,
  );
  return `<nav class="crumbs" aria-label="麵包屑">
            ${parts.join('\n            ')}
          </nav>`;
}

/** 整頁輸出單一 @graph，節點之間才有辦法用 @id 互相參照。 */
function ldJson(nodes) {
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': nodes.filter(Boolean),
  })}</script>`;
}

/**
 * 一篇文章的正規網址。
 *
 * 轉載文的正本在原刊媒體，canonical、JSON-LD 的 url 與 mainEntityOfPage
 * 都必須是同一個值。以前首頁的 blogPost 陣列自己算了一份 `${origin}/${slug}/`，
 * 於是同一篇文章在兩處結構化資料拿到兩個不同的正規網址——這正是
 * Search Console「重複網頁，使用者未選取標準網頁」的典型來源。抽成共用函式。
 */
function postCanonicalUrl(post) {
  return post.originalUrl || (origin ? `${origin}/${post.slug}/` : '');
}

/** 文章的 hero 圖，輸出成 ImageObject（絕對網址）。 */
function postImageLd(post) {
  const h = heroFor(post);
  if (!origin || !h?.src) return undefined;
  return {
    '@type': 'ImageObject',
    url: `${origin}/${String(h.src).replace(/^\/+/, '')}`,
    width: Number(h.width),
    height: Number(h.height),
  };
}

/* ------------------------------------------------------------- 首頁 --- */

function renderIndex(posts) {
  const newest = contentUpdated;

  // 首頁只留核心：宣言、照片、三項專業定位、最近幾篇。
  // 其餘四個區塊各自是獨立頁面，由頁首導覽進入。
  const latest = posts.slice(0, Number(site.homeLatestCount) || 4);

  const content = `${profileBlock()}${cardSection('about', '', site.about)}
      <div class="wrap">
        <section class="listing">
          <div class="listing__head">
            <h2>最新文章</h2>
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
          ${cardsBlock(latest)}
          ${
            posts.length > latest.length
              ? `<p class="listing__more"><a href="articles/">查看全部 ${posts.length} 篇文章 →</a></p>`
              : ''
          }
        </section>
      </div>`;

  return layout({
    // 中文 SERP 大約只顯示 20-28 個全形字，title 用短版 tagline，
    // 長版留給 hero 的 lede（頁面上看得到的那一句）。
    title: `${site.title}｜${site.shortTagline || site.tagline}`,
    description: site.description,
    bodyClass: 'page-home',
    pageSlug: 'site-home',
    head: ldJson([
      websiteNode(),
      {
        '@type': 'Blog',
        ...(origin ? { '@id': `${origin}/#blog`, url: `${origin}/` } : {}),
        name: site.title,
        description: site.description,
        inLanguage: 'zh-Hant-TW',
        ...(origin ? { isPartOf: { '@id': WEBSITE_ID } } : {}),
        ...(origin ? { breadcrumb: { '@id': `${origin}/#breadcrumb` } } : {}),
        // 作者與發行者一律引用 /about/ 的那一個 Person 節點，
        // 讓搜尋引擎有依據把全站的作者訊號合併成同一個實體。
        author: personRef(),
        publisher: personRef(),
        // 首頁是文章索引頁，把 Blog → BlogPosting 的關聯明講出來。
        // 卡片本身仍是靜態 HTML，這裡只是額外的結構化訊號。
        blogPost: posts.map((p) => ({
          '@type': 'BlogPosting',
          headline: p.title,
          description: p.summary || undefined,
          // 轉載文的 url 要跟它自己那一頁的 canonical 一致（指向原刊媒體），
          // 不能在這裡宣告成本站網址。
          ...(postCanonicalUrl(p) ? { url: postCanonicalUrl(p) } : {}),
          image: postImageLd(p),
          datePublished: isoDate(p.published),
          dateModified: isoDate(p.updated),
          author: p.author === site.author ? personRef() : { '@type': 'Person', name: p.author },
        })),
      },
      breadcrumbLd(
        [{ name: site.title, url: origin ? `${origin}/` : '' }],
        origin ? `${origin}/#breadcrumb` : '',
      ),
    ]),
    content,
    // 首頁已不再使用那張 CC BY 的建築照，footer 就不該繼續掛它的授權聲明
    // （錯誤標示比不標示更糟）。CC BY 的義務由實際使用它的文章頁承擔。
    hero: { credit: '首頁人像照由本站作者提供。' },
  });
}

/**
 * 轉載聲明。有填 originalUrl 才會出現。
 *
 * 注意：這個 <a> 以前掛了 rel="canonical"。rel=canonical 只在 <link> 元素
 * （或 HTTP Link 標頭）上有定義，放在 <a> 上爬蟲不會處理，只是噪音，
 * 還會讓維護者以為 canonical 是靠它生效。真正的 canonical 在 <head>。
 */
/**
 * 獨立頁面（關於我／我的服務／合作成果／聯絡方式／文章）。
 *
 * 這些頁面沒有主圖，所以 hero 傳 null，footer 就不會掛圖片出處。
 * 頁面標題用 h1，底下的區塊一律不再重複輸出標題。
 */
function renderStandalone({
  slug, label, description, lede = '', body,
  pageType = 'WebPage', extraLd = [], mainEntity,
}) {
  const pageUrl = origin ? `${origin}/${slug}/` : '';

  // 麵包屑：首頁 › 這一頁。以前這五頁的 JSON-LD 只有單一 WebPage 節點，
  // SERP 上只顯示裸網址，Google 也無從得知站台層級。
  const crumbs = [
    { name: site.title, url: origin ? `${origin}/` : '', href: '../' },
    { name: label, url: pageUrl, href: `../${slug}/` },
  ];

  const content = `
      <section class="page-head">
        <div class="wrap">
          ${crumbsNav(crumbs)}
          <h1 class="page-head__title">${escapeHtml(label)}</h1>
          ${lede ? `<p class="page-head__lede">${markEn(escapeHtml(lede))}</p>` : ''}
        </div>
      </section>
${body}`;

  return layout({
    title: `${label}｜${site.title}`,
    description,
    bodyClass: 'page-standalone',
    pageSlug: slug,
    // og:type 依規範 article 必須伴隨 article:published_time，這幾頁一個都沒有；
    // 它們的 JSON-LD 也是 WebPage，宣告成 article 只會讓兩邊互相打架。
    ogType: 'website',
    head: ldJson([
      websiteNode(),
      {
        '@type': pageType,
        ...(pageUrl ? { '@id': `${pageUrl}#webpage`, url: pageUrl } : {}),
        name: label,
        description,
        inLanguage: 'zh-Hant-TW',
        ...(origin
          ? { isPartOf: { '@id': WEBSITE_ID }, breadcrumb: { '@id': `${pageUrl}#breadcrumb` } }
          : {}),
        about: personRef(),
        ...(mainEntity ? { mainEntity } : {}),
      },
      breadcrumbLd(crumbs, pageUrl ? `${pageUrl}#breadcrumb` : ''),
      ...extraLd,
    ]),
    content,
    hero: null,
  });
}

/** 全部文章索引。首頁只放最近幾篇，其餘從這裡進入。 */
function renderArticles(posts) {
  return renderStandalone({
    slug: 'articles',
    label: '全部文章',
    // description 不放篇數：每發一篇文章描述就變一次，等於把一段可控的
    // SERP 文案綁在一個會漂移的數字上。頁面上的 lede 保留篇數。
    description: site.pageMeta?.articles || site.description,
    lede: `共 ${posts.length} 篇${contentUpdated ? `，內容最後更新 ${fmtDate(contentUpdated)}` : ''}。`,
    body: `
      <div class="wrap">
        <section class="listing">
          ${cardsBlock(posts, '../', 2, true)}
        </section>
      </div>`,
  });
}

/**
 * 時間軸的線條圖示。
 * 內嵌 SVG 而非圖檔或字型：沒有額外請求、跟著文字色走、放大不糊。
 * aria-hidden——旁邊就有文字說明，讓螢幕閱讀器唸圖示只會變成雜訊。
 */
const JOURNEY_ICONS = {
  care: '<path d="M12 20s-6.4-4.2-8.3-7.5A4.7 4.7 0 0 1 12 7.2a4.7 4.7 0 0 1 8.3 5.3C18.4 15.8 12 20 12 20z"/>',
  social:
    '<circle cx="9" cy="8" r="3"/><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0"/><circle cx="17.5" cy="10.5" r="2.2"/><path d="M16.5 19.5a4.8 4.8 0 0 1 4-4.2"/>',
  manage:
    '<path d="M4 21V6.6L11 3.5l7 3.1V21"/><path d="M2.5 21h19"/><path d="M9.5 21v-4.5h3V21"/><path d="M8 9.5h1.5M13 9.5h1.5M8 13h1.5M13 13h1.5"/>',
  study:
    '<path d="M12 4 2.5 8.7 12 13.4l9.5-4.7L12 4z"/><path d="M6.2 11v4.3c0 1.6 2.6 2.9 5.8 2.9s5.8-1.3 5.8-2.9V11"/>',
  share:
    '<circle cx="6" cy="12" r="2.4"/><circle cx="18" cy="6.2" r="2.4"/><circle cx="18" cy="17.8" r="2.4"/><path d="M8.2 10.9 15.8 7.3M8.2 13.1l7.6 3.6"/>',
};

function journeyIcon(name) {
  const paths = JOURNEY_ICONS[name] || JOURNEY_ICONS.share;
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

/**
 * 品牌故事型時間軸。
 * 手機直式（線在左側）、桌機橫式（線穿過圖示）——同一份 HTML，只換 CSS。
 * 用 <ol> 是因為這些節點有先後順序，語意上就是有序清單。
 */
function journeyBlock() {
  const j = site.journey;
  if (!Array.isArray(j?.steps) || !j.steps.length) return '';

  return `
      <section class="section journey">
        <div class="wrap">
          <h2 class="section__head section__head--center">${escapeHtml(j.heading || '我的長照旅程')}</h2>
          ${j.lede ? `<p class="section__lede section__lede--center">${markEn(escapeHtml(j.lede))}</p>` : ''}
          <ol class="journey__list">
${j.steps
  .map(
    (s, i) => `            <li class="journey__step">
              <span class="journey__icon">${journeyIcon(s.icon)}</span>
              <div class="journey__body">
                <span class="journey__num" aria-hidden="true">0${i + 1}</span>
                <h3 class="journey__stage">${escapeHtml(s.stage)}</h3>
                ${s.role ? `<p class="journey__role">${escapeHtml(s.role)}</p>` : ''}
                ${s.detail ? `<p class="journey__detail">${escapeHtml(s.detail)}</p>` : ''}
              </div>
            </li>`,
  )
  .join('\n')}
          </ol>
          ${j.motto ? `<p class="motto">${escapeHtml(j.motto)}</p>` : ''}
        </div>
      </section>`;
}

/**
 * 「關於我」的敘事段落 ＋ 形象照 ＋ 使命宣言。
 *
 * 敘事文字寬度壓在 42rem（超過就難讀），右側原本是空白，
 * 拿來放形象照剛好，版面也不會左重右輕。
 *
 * 使命宣言用逐行輸出而非讓它自然斷行：句子在「知識；」之後換行才順，
 * 交給瀏覽器斷會斷在不該斷的地方。
 */
/**
 * 團隊領導成果（關於我）。
 * 敘事之後、旅程時間軸之前——先講理念與成果，再展開職涯歷程。
 * 獎項名稱是作者提供的事實，逐字輸出，不做任何改寫或補充。
 */
function leadershipBlock(up = '../') {
  const l = site.leadership;
  if (!l || !Array.isArray(l.paragraphs) || !l.paragraphs.length) return '';

  const widths = Array.isArray(l.photoSrcsetWidths) ? l.photoSrcsetWidths : [];
  const stem = String(l.photo || '').replace(/\.[^./]+$/, '');
  const srcset = widths.length
    ? escapeHtml(
        widths
          .map((w) => `${assetVer(`${up}${stem}-${w}.webp`)} ${w}w`)
          .concat(`${assetVer(up + l.photo)} ${Number(l.photoWidth) || 1477}w`)
          .join(', '),
      )
    : '';

  const figure = l.photo
    ? `<figure class="award">
            <img
              class="award__img"
              src="${escapeHtml(assetVer(up + l.photo))}"${srcset ? `
              srcset="${srcset}"
              sizes="(max-width: 52rem) 100vw, 26rem"` : ''}
              alt="${escapeHtml(l.photoAlt || '')}"
              width="${Number(l.photoWidth) || 1477}"
              height="${Number(l.photoHeight) || 1108}"
              loading="lazy"
              decoding="async"
            />
            ${l.photoCaption ? `<figcaption class="award__caption">${escapeHtml(l.photoCaption)}</figcaption>` : ''}
          </figure>`
    : '';

  return `
      <section class="section leadership">
        <div class="wrap">
          <h2 class="section__head">${escapeHtml(l.heading || '')}</h2>
          <div class="leadership__inner">
            <div class="story__body">
${l.paragraphs.map((t) => `              <p>${escapeHtml(t)}</p>`).join('\n')}
            </div>
            ${figure}
          </div>
        </div>
      </section>`;
}

/**
 * 外部連結（關於我）。
 * 刊在別人網站上的作品與授課紀錄，對讀者是佐證，
 * 對搜尋引擎也是「這個人在站外真的存在」的關聯訊號。
 */
function externalLinksBlock() {
  const e = site.externalLinks;
  if (!Array.isArray(e?.items) || !e.items.length) return '';

  return `
      <section class="section external">
        <div class="wrap">
          <h2 class="section__head section__head--center">${escapeHtml(e.heading || '外部連結')}</h2>
          ${e.lede ? `<p class="section__lede section__lede--center">${escapeHtml(e.lede)}</p>` : ''}
          <ul class="external__list">
${e.items
  .map(
    (i) => `            <li class="external__item">
              <a href="${escapeHtml(i.url)}" target="_blank" rel="noopener noreferrer" aria-describedby="newtab-note">${escapeHtml(i.title)}</a>
              <p class="external__meta">
                <span class="external__site">${escapeHtml(i.site)}</span>${i.note ? `<span class="dot" aria-hidden="true">·</span><span>${escapeHtml(i.note)}</span>` : ''}
              </p>
            </li>`,
  )
  .join('\n')}
          </ul>
        </div>
      </section>`;
}

function storyBlock(up = '../') {
  const s = site.aboutStory;
  if (!s) return '';

  const p = site.profile || {};
  const photo = p.photo
    ? `<figure class="story__figure">
              <img
                class="story__photo"
                src="${escapeHtml(assetVer(up + p.photo))}"${
                  p.photoSmall
                    ? `
                srcset="${escapeHtml(assetVer(up + p.photoSmall))} 280w, ${escapeHtml(assetVer(up + p.photo))} ${Number(p.photoSize) || 560}w"
                sizes="18rem"`
                    : ''
                }
                alt="${escapeHtml(p.photoAlt || p.name || '')}"
                width="${Number(p.photoSize) || 560}"
                height="${Number(p.photoSize) || 560}"
                decoding="async"
              />
            </figure>`
    : '';

  const lines = Array.isArray(s.missionLines)
    ? s.missionLines
    : s.mission
      ? [s.mission]
      : [];

  return `
      <section class="section story">
        <div class="wrap story__inner">
          <div class="story__body">
${(s.paragraphs || []).map((t) => `            <p>${escapeHtml(t)}</p>`).join('\n')}
          </div>
          ${photo}
        </div>
        ${
          lines.length
            ? `<div class="wrap">
          <p class="story__mission">
${lines.map((t) => `            <span>${escapeHtml(t)}</span>`).join('\n')}
          </p>
        </div>`
            : ''
        }
      </section>`;
}

/** 四個獨立頁面的定義。內容全部來自 site.config.json。 */
function standalonePages() {
  const svc = site.servicesPage || {};
  const res = site.resultsPage || {};

  return [
    {
      slug: 'about',
      label: '關於我',
      description: `${site.author}：長照機構營運與評鑑顧問、社工教師。從照顧服務員、社工到機構主任，現就讀東海大學社工博士班。`,
      // 這一頁有完整的職涯敘事，是全站最該建立 E-E-A-T 的一頁。
      // 型別升為 ProfilePage，mainEntity 掛上唯一一份展開的 Person 節點。
      pageType: 'ProfilePage',
      mainEntity: personNode(true),
      body: `${storyBlock()}${leadershipBlock()}${journeyBlock()}${cardSection('about', '專業定位', site.about, { center: true })}${externalLinksBlock()}`,
    },
    {
      slug: 'services',
      label: '我的服務',
      description: site.pageMeta?.services || site.description,
      lede: svc.lede || '',
      // 三項可販售的顧問服務，以前只是泛型 WebPage，無法被理解成服務項目頁。
      extraLd: Array.isArray(site.services) && site.services.length
        ? [{
            '@type': 'OfferCatalog',
            ...(origin ? { '@id': `${origin}/services/#catalog` } : {}),
            name: '長照顧問服務',
            itemListElement: site.services.map((s) => ({
              '@type': 'Service',
              name: s.title,
              description: s.detail,
              provider: personRef(),
              areaServed: { '@type': 'Country', name: '臺灣' },
              serviceType: s.title,
            })),
          }]
        : [],
      body: `${cardSection('services', '', site.services, { intro: svc.intro })}${ctaBlock(svc.cta)}`,
    },
    {
      slug: 'results',
      label: '顧問成果',
      description: `${site.author}擔任長照機構營運暨評鑑顧問的實績：輔導社區式長照機構建立營運制度、評鑑準備與品質管理機制。`,
      // 客戶是一間公司、成果是一份清單，兩個現成的型別都沒宣告過。
      // 資料全部沿用 site.config.json 既有欄位，沒有新增文案。
      extraLd: [
        ...(res.client?.name
          ? [{
              '@type': 'Organization',
              ...(origin ? { '@id': `${origin}/results/#client` } : {}),
              name: res.client.name,
            }]
          : []),
        ...(Array.isArray(res.achievements) && res.achievements.length
          ? [{
              '@type': 'ItemList',
              ...(origin ? { '@id': `${origin}/results/#achievements` } : {}),
              name: res.achievementsHeading || '輔導成效',
              itemListElement: res.achievements.map((t, i) => ({
                '@type': 'ListItem',
                position: i + 1,
                name: t,
              })),
            }]
          : []),
      ],
      body: resultsBlock(),
    },
    {
      slug: 'contact',
      label: '聯絡方式',
      description: site.pageMeta?.contact || site.description,
      lede: site.contactPage?.lede || '',
      body: contactBlock(),
    },
  ];
}

/**
 * 分享列。
 *
 * Facebook 與 LINE 用純分享網址，**不嵌任何官方 SDK**——
 * 嵌 SDK 等於讓對方在自己的網站上追蹤每一位訪客，代價遠大於便利。
 * 純連結沒有 JS、沒有追蹤，也照樣能用。
 *
 * 「複製連結」必須有 JS 才有作用，所以預設 hidden，由 share.js 打開；
 * 沒有 JS 的訪客不會看到一顆按了沒反應的按鈕。
 */
function shareBlock({ url, title, compact = false, variant = '' } = {}) {
  if (!origin || !url) return '';

  const u = encodeURIComponent(url);
  const t = encodeURIComponent(title || '');

  const icon = (paths) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;

  const clip = icon(
    '<path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  );
  const fb = icon(
    '<path d="M17 2h-3a5 5 0 0 0-5 5v3H6v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/>',
  );
  const line = icon(
    '<path d="M21 10.4c0-4.1-4-7.4-9-7.4S3 6.3 3 10.4c0 3.6 3.2 6.7 7.5 7.3.3.1.7.2.8.5.1.3.1.6 0 .9l-.1.8c0 .3-.2 1 .9.5s5.7-3.4 7.7-5.8h0A6.6 6.6 0 0 0 21 10.4z"/>',
  );

  // 精簡版放在文章開頭的作者列右側，只有圖示；
  // 圖示沒有文字標籤，可及名稱一律用 aria-label 補足，不能只靠 title。
  const label = (text) =>
    compact ? ` aria-label="${escapeHtml(text)}" title="${escapeHtml(text)}"` : '';
  const text = (t2) => (compact ? '' : `<span>${escapeHtml(t2)}</span>`);

  return `
          <div class="share${compact ? ' share--compact' : ''}${variant ? ` share--${variant}` : ''}">
            ${compact ? '<span class="sr-only">分享這篇</span>' : '<span class="share__label">分享這篇</span>'}
            <button type="button" class="share__btn" data-share-url="${escapeHtml(url)}"${label('複製連結')} hidden>
              ${clip}${text('複製連結')}
            </button>
            <a class="share__btn" href="https://www.facebook.com/sharer/sharer.php?u=${u}" target="_blank" rel="noopener noreferrer" aria-describedby="newtab-note"${label('分享到 Facebook')}>
              ${fb}${text('Facebook')}
            </a>
            <a class="share__btn" href="https://social-plugins.line.me/lineit/share?url=${u}&amp;text=${t}" target="_blank" rel="noopener noreferrer" aria-describedby="newtab-note"${label('分享到 LINE')}>
              ${line}${text('LINE')}
            </a>
            <span class="share__status" role="status" aria-live="polite"></span>
          </div>`;
}

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
  const pageUrl = postCanonicalUrl(post);
  const heroUrl = origin ? `${origin}/${String(hero.src).replace(/^\/+/, '')}` : '';
  // 麵包屑與 @id 一律用本站自己的網址：轉載文的 canonical 指向站外，
  // 但它在這個站台的層級位置仍然是「首頁 › 全部文章 › 這一篇」。
  const selfUrl = origin ? `${origin}/${post.slug}/` : '';

  const crumbs = [
    { name: site.title, url: origin ? `${origin}/` : '', href: '../' },
    { name: '全部文章', url: origin ? `${origin}/articles/` : '', href: '../articles/' },
    { name: post.title, url: selfUrl, href: `../${post.slug}/` },
  ];

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
          ${crumbsNav(crumbs)}
          <div class="post__head">
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
${shareBlock({ url: `${origin}/${post.slug}/`, title: post.title, compact: true })}
          </div>
${reprintNotice(post)}
          <div class="prose">
${post.html}
          </div>
${shareBlock({ url: `${origin}/${post.slug}/`, title: post.title })}
${otherPostsBlock(post, posts)}
          <p class="post__back"><a href="../articles/"><span aria-hidden="true">←</span> 回到文章列表</a></p>
        </article>
      </div>`;

  const blogPosting = {
    '@type': 'BlogPosting',
    headline: post.title,
    description: post.summary,
    inLanguage: 'zh-Hant-TW',
    ...(origin
      ? { isPartOf: { '@id': WEBSITE_ID }, breadcrumb: { '@id': `${selfUrl}#breadcrumb` } }
      : {}),
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
    // 作者與發行者引用 /about/ 的那一個 Person 節點，全站合併成同一個實體。
    author: post.author === site.author ? personRef() : { '@type': 'Person', name: post.author },
    publisher: personRef(),
    ...(post.tags.length ? { keywords: post.tags.join(', ') } : {}),
    ...(post.originalUrl
      ? { isBasedOn: post.originalUrl, creditText: post.originalSite || undefined }
      : {}),
  };

  return layout({
    title: post.seoTitle || `${post.title}｜${site.title}`,
    description: post.metaDescription || post.summary || site.description,
    bodyClass: 'page-post',
    pageSlug: post.slug,
    head: `<meta property="article:published_time" content="${isoDate(post.published)}" />
<meta property="article:modified_time" content="${isoDate(post.updated)}" />
<meta property="article:author" content="${escapeHtml(post.author)}" />
${ldJson([
  websiteNode(),
  blogPosting,
  breadcrumbLd(crumbs, selfUrl ? `${selfUrl}#breadcrumb` : ''),
])}`,
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
    // 這一頁沒有主圖。以前傳 site.hero 會讓 og:image 掛上那張 CC BY 的
    // 建築照——照片在頁面上一次都沒出現，而且因為走的不是 footer 那條
    // 有授權資訊的分支，等於在未標示的情況下使用 CC BY 素材。
    // 傳 null 之後 og:image 退回 assets/img/og-card.jpg。
    hero: null,
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

// 四個獨立頁面 + 全部文章索引
const pages = [...standalonePages(), {
  slug: 'articles',
  label: '文章',
  html: renderArticles(posts),
}];

for (const page of pages) {
  const dir = join(OUT_DIR, page.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'index.html'),
    page.html || renderStandalone(page),
    'utf8',
  );
}

for (const post of posts) {
  const dir = join(OUT_DIR, post.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'index.html'), renderPost(post, posts), 'utf8');
}

// sitemap / robots / feed：Cloudflare Pages 與 GitHub Pages 都能直接吃
if (origin) {
  // 四個介紹頁的內容全部來自 site.config.json，那個檔案的異動時間
  // 才是它們真正的 lastmod。以前一律用 contentUpdated，代表隨便發一篇
  // 新文章這五頁的 lastmod 就一起跳日期——Google 觀察到 lastmod 與實際
  // 內容變動不符時會整站忽略這個訊號，之後真的改了 /about/ 反而沒得用。
  const configMtime = (await stat(join(ROOT, 'site.config.json'))).mtime;

  const urls = [
    // 首頁的 lastmod 要反映「所有文章的最新更新時間」。
    // posts[0] 只是發布日最新的那篇，不見得是最後被改動的那篇。
    { loc: `${origin}/`, lastmod: isoDate(contentUpdated || new Date()) },
    ...pages.map((p) => ({
      loc: `${origin}/${p.slug}/`,
      // /articles/ 是例外：它的內容確實隨文章清單變動。
      lastmod: p.slug === 'articles'
        ? isoDate(contentUpdated || new Date())
        : isoDate(configMtime),
    })),
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

  /**
   * RSS feed。
   *
   * sitemap 是給搜尋引擎的清單，feed 是給讀者的閱讀器、內容聚合站與
   * 想轉載的媒體。對一個要被同業引用的個人品牌站，這是取得外部連結
   * 最便宜的入口，而目前完全沒有。
   *
   * 轉載文一樣過濾掉，與 sitemap 的策略一致：正本在原刊媒體，
   * 從自己的 feed 再推一份出去只會製造重複內容。
   */
  const feedPosts = posts.filter((p) => !p.originalUrl);
  const rssDate = (d) => new Date(d).toUTCString();
  const feedItems = feedPosts
    .map((p) => {
      const url = `${origin}/${p.slug}/`;
      return `    <item>
      <title>${escapeHtml(p.title)}</title>
      <link>${escapeHtml(url)}</link>
      <guid isPermaLink="true">${escapeHtml(url)}</guid>
      <pubDate>${rssDate(p.published)}</pubDate>
      <description>${escapeHtml(p.summary || p.title)}</description>
      <dc:creator>${escapeHtml(p.author)}</dc:creator>
${p.tags.map((t) => `      <category>${escapeHtml(t)}</category>`).join('\n')}
    </item>`;
    })
    .join('\n');

  await writeFile(
    join(OUT_DIR, 'feed.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>${escapeHtml(site.title)}</title>
    <link>${escapeHtml(`${origin}/`)}</link>
    <description>${escapeHtml(site.description)}</description>
    <language>zh-TW</language>
    <lastBuildDate>${rssDate(contentUpdated || new Date())}</lastBuildDate>
    <atom:link href="${escapeHtml(`${origin}/feed.xml`)}" rel="self" type="application/rss+xml" />
${feedItems}
  </channel>
</rss>
`,
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
