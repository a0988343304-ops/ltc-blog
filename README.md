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

## 目錄結構

```
content/posts/     文章原始 Markdown（唯一需要手動編輯的地方）
static/            會原封不動複製到輸出目錄的檔案（CSS / JS / 圖片）
build.mjs          靜態產生器
site.config.json   站台設定：標題、作者、HERO 圖授權、Supabase 金鑰
supabase/schema.sql 計數器資料表與函式
docs/              建置輸出（GitHub Pages 與 Cloudflare Pages 都吃這個目錄）
```

`docs/` 是產生出來的，但**有進版控**——GitHub Pages 需要直接讀到它。

## 瀏覽計數器

用 Supabase 記錄每篇文章與首頁的瀏覽次數。

1. 到 Supabase SQL Editor 執行 `supabase/schema.sql`。
2. 把專案的 Project URL 與 anon public key 填進 `site.config.json` 的 `supabase` 區塊。
3. 重新 build。

anon key 是設計成公開放在前端的；真正的防線是 `schema.sql` 裡的 RLS 政策——匿名訪客只能讀取，寫入一律經過 `increment_view()` 函式，沒辦法把數字改成任意值。

設定留空時計數器會安靜停用，網站其餘功能不受影響。

## HERO 圖授權

首頁與文章的 HERO 圖為 CC BY 4.0 授權，出處標示在每一頁的 footer。換圖時請同步更新 `site.config.json` 的 `hero` 區塊，包含作者、授權條款與來源網址——**CC BY 的義務就是這個標示**。

若對圖片做過裁切或調色，把 `hero.modified` 設為 `true`，footer 會一併說明。
