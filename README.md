# 長照機構營運管理

聚焦台灣長照機構營運實務的部落格。純靜態網站，無前端框架、無執行期相依。

## 怎麼發一篇新文章

1. 在 `content/posts/` 新增一個 `.md` 檔，**檔名就是網址**：

   ```
   content/posts/20260815-staffing-ratio.md
   → https://<站台>/20260815-staffing-ratio
   ```

2. 檔頭寫 front matter：

   ```markdown
   ---
   title: 照護比怎麼算才不會踩線
   date: 2026-08-15
   summary: 一句話說明，會顯示在首頁卡片上。
   tags: 人力配置, 法規遵循
   ---

   正文從這裡開始……
   ```

   | 欄位 | 必填 | 說明 |
   |---|---|---|
   | `title` | 是 | 文章標題 |
   | `date` | 否 | 發布日期，省略時從檔名前綴 `YYYYMMDD` 推得 |
   | `summary` | 否 | 首頁卡片摘要 |
   | `tags` | 否 | 逗號分隔 |
   | `author` | 否 | 省略時用 `site.config.json` 的預設作者 |
   | `draft` | 否 | 設 `true` 則不輸出 |

3. 建置：

   ```bash
   npm run build
   ```

4. 推上去：

   ```bash
   git add -A && git commit -m "post: 照護比怎麼算" && git push
   ```

首頁卡片會自動長出來、自動依日期新到舊重排，不需要手動改 `index.html`。

## 日期是怎麼決定的

- **發布日期** — front matter 的 `date`，或檔名前綴。
- **最後更新日期** — 取自該 `.md` 檔在 git 的最後一次 commit 時間。改了文章、commit 上去，日期就跟著換，不用手動維護。沒有 git 紀錄時退回檔案修改時間。

首頁的「內容最後更新」則取所有文章更新時間的最大值。

## 本機預覽

```bash
npm install
npm run build
node serve.mjs
```

開 <http://localhost:4173>。

## 部署

推上 `main` 之後全自動，不需要手動做任何事：

```
git push
   │
   ├─→ GitHub Actions ─ npm ci → npm run build
   │                    └─ docs/ 若與原始內容有落差就重建並推回
   │                    └─ wrangler pages deploy → Cloudflare Pages
   │
   └─→ GitHub Pages ─ 直接供應 main 分支的 /docs
```

| 站台 | 網址 | 角色 |
|---|---|---|
| Cloudflare Pages | <https://ltc-blog.pages.dev> | 正式站，`canonical` 指向這裡 |
| GitHub Pages | <https://a0988343304-ops.github.io/ltc-blog/> | 鏡像站 |

兩邊掛同一份內容，所以每頁的 `canonical` 都指向 Cloudflare，避免搜尋引擎判定為重複內容而自行挑一個排名。

### 需要的 secrets

| 名稱 | 用途 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 帳號 ID |
| `CLOUDFLARE_API_TOKEN` | 權限只需 Cloudflare Pages:Edit 與 D1:Edit |

更新 token（輸入不會顯示在畫面上）：

```bash
gh secret set CLOUDFLARE_API_TOKEN --repo a0988343304-ops/ltc-blog
```

### 手動部署

CI 壞掉時的退路：

```bash
npm run build && wrangler pages deploy
```

## 目錄結構

```
content/posts/       文章原始 Markdown（唯一需要手動編輯的地方）
static/              會原封不動複製到輸出目錄的檔案（CSS / JS / 圖片）
build.mjs            靜態產生器
site.config.json     站台設定：標題、作者、HERO 圖授權、計數器 API
functions/api/       Cloudflare Pages Functions（計數器 API）
cloudflare/schema.sql D1 資料表結構
wrangler.toml        Cloudflare Pages 與 D1 綁定設定
docs/                建置輸出（GitHub Pages 與 Cloudflare Pages 都吃這個目錄）
```

`docs/` 是產生出來的，但**有進版控**——GitHub Pages 需要直接讀到它。

## 瀏覽計數器

每篇文章與首頁各有獨立計數，資料存在 **Cloudflare D1**，由 Pages Functions 提供 API。

```
GET  /api/views          → { "site-home": 12, "20260802-introduction": 5 }
POST /api/views {slug}   → { slug, views }
```

- 計數用 SQLite 的 `INSERT ... ON CONFLICT DO UPDATE` 一次完成，是原子操作，併發時不會掉數字。
- `slug` 只接受 `[A-Za-z0-9_-]{1,128}`，其餘一律 400。
- 同一個瀏覽器工作階段內同一頁只計一次，重新整理不灌水。
- 首頁卡片上的數字是 JS 填進**既有的靜態 HTML 欄位**，不會生成卡片，列表的 SEO 不受影響。

資料表結構在 `cloudflare/schema.sql`，套用方式：

```bash
wrangler d1 execute ltc-blog-views --remote --file=./cloudflare/schema.sql
```

歸零重來：

```bash
wrangler d1 execute ltc-blog-views --remote --command "DELETE FROM page_views;"
```

`site.config.json` 的 `counter.apiBase` 留空時計數器會安靜停用，網站其餘功能不受影響。GitHub Pages 鏡像站因為沒有後端，是跨網域呼叫 Cloudflare 這支 API（CORS 白名單寫在 `functions/api/views.js`）。

## HERO 圖授權

首頁與文章的 HERO 圖為 CC BY 4.0 授權，出處標示在每一頁的 footer。換圖時請同步更新 `site.config.json` 的 `hero` 區塊，包含作者、授權條款與來源網址——**CC BY 的義務就是這個標示**。

若對圖片做過裁切或調色，把 `hero.modified` 設為 `true`，footer 會一併說明。
