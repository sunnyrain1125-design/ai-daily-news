# AI Daily News

自動抓取最近 24 小時內與 `OpenAI`、`Anthropic`、`Google Gemini`、`Meta AI` 相關新聞，使用 Gemini 搜尋工具整理成繁體中文摘要，並分類為：

- `Technical Breakthroughs`
- `Tool Applications`
- `Industry Impact`

網站前端是單頁式 Tailwind Dashboard，後端使用 Node.js + Express，資料會儲存到 `public/data.json`，避免每次開頁都重新呼叫模型。

## 1. 本機準備

安裝依賴：

```bash
pnpm install
```

建立 `.env`：

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
NEWS_TIMEZONE=Asia/Taipei
NEWS_CRON=0 8 * * *
CRON_SECRET=replace_with_a_long_random_secret
```

注意：

- `.env` 不要提交到 GitHub
- 專案已透過 `.gitignore` 忽略 `.env`

## 2. 本機測試

先手動刷新一次新聞：

```bash
pnpm refresh
```

再啟動網站：

```bash
pnpm start
```

開啟：

- `http://localhost:3000/`
- `http://localhost:3000/api/health`
- `http://localhost:3000/data.json`

## 3. 推到 GitHub

如果這個資料夾還沒初始化 git，可以執行：

```bash
git init
git branch -M main
git add .
git commit -m "Initial AI Daily News app"
```

接著建立 GitHub repo，然後執行：

```bash
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

## 4. GitHub Actions + GitHub Pages 免費自動更新

這個專案已包含：

- `.github/workflows/update-news.yml`
- `.github/workflows/deploy-pages.yml`

用途如下：

- `update-news.yml`：每天自動執行 `pnpm refresh`，更新 `public/data.json`，然後提交回 repo
- `deploy-pages.yml`：每次 `main` 分支更新後，自動把 `public/` 部署到 GitHub Pages

### 在 GitHub 設定 Secrets

到 repo：

`Settings` → `Secrets and variables` → `Actions`

新增這些 repository secrets：

- `GEMINI_API_KEY`
- `GEMINI_MODEL`：`gemini-2.5-flash`
- `NEWS_TIMEZONE`：`Asia/Taipei`
- `NEWS_CRON`：`0 8 * * *`
- `CRON_SECRET`：任意長亂數字串

### 啟用 GitHub Pages

到 repo：

`Settings` → `Pages`

在 `Build and deployment`：

- `Source` 選 `GitHub Actions`

### 排程時間說明

GitHub Actions 已改成 timezone-aware schedule，目標是每天台北時間 `08:05` 自動更新。之所以不是 `08:00`，是因為 GitHub 官方說明整點是高負載時段，排程更容易延遲；將時間微幅錯開能降低延遲機率。

注意：GitHub 官方有說明，`schedule` 工作流在高峰時段可能延遲，尤其整點更容易延誤，因此免費方案無法保證秒級或分鐘級精準 08:00。

### 手動更新

你也可以到 GitHub repo 的 `Actions` 頁面，手動執行 `Update AI Daily News` workflow。

## 5. Render 部署

### 建議方案

如果你要每天早上 08:00 自動更新，建議使用付費 Web Service，因為：

- Free Web Service 可能休眠
- `node-cron` 需要服務常駐
- `public/data.json` 需要持久化保存

### 在 Render 建立服務

1. 到 Render Dashboard
2. 點 `New` → `Blueprint`
3. 連接你的 GitHub repo
4. 選擇這個專案
5. Render 會自動讀取根目錄的 `render.yaml`

如果你不用 Blueprint，也可以手動建立 `Web Service`，設定如下：

- Build Command: `npm install`
- Start Command: `node server.js`

### 環境變數

在 Render 後台設定：

- `GEMINI_API_KEY`
- `GEMINI_MODEL=gemini-2.5-flash`
- `NEWS_TIMEZONE=Asia/Taipei`
- `NEWS_CRON=0 8 * * *`
- `CRON_SECRET`

`PORT` 不需要手動設定，Render 會自動提供。

### Persistent Disk

這個專案會把資料寫到：

```txt
/opt/render/project/src/public/data.json
```

所以請在 Render 為這個 Web Service 掛一顆 Persistent Disk，掛載路徑填：

```txt
/opt/render/project/src/public
```

這樣 redeploy 或重啟後，資料仍會保留。

## 6. 部署完成後檢查

打開以下網址：

- `https://YOUR-SERVICE.onrender.com/`
- `https://YOUR-SERVICE.onrender.com/api/health`
- `https://YOUR-SERVICE.onrender.com/data.json`

如果首頁可以開、`/api/health` 顯示 `ok: true`，且 `/data.json` 有內容，就代表部署成功。

## 7. 手動刷新

如果你要手動觸發一次刷新，可以呼叫：

```txt
GET /api/refresh
Authorization: Bearer YOUR_CRON_SECRET
```

例如：

```bash
curl -H "Authorization: Bearer YOUR_CRON_SECRET" \
  https://YOUR-SERVICE.onrender.com/api/refresh
```

## 8. 重要安全提醒

- 不要把 `.env` 上傳到 GitHub
- 不要把 `GEMINI_API_KEY` 寫死在程式碼中
- 若金鑰外洩，請立刻到 Google AI Studio 或 Google Cloud 重新產生新金鑰
