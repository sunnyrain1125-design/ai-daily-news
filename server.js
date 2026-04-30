const fs = require("fs/promises");
const path = require("path");
const express = require("express");
const cron = require("node-cron");
const { GoogleGenAI } = require("@google/genai");
require("dotenv").config();

const app = express();
const port = Number(process.env.PORT || 3000);
const timezone = process.env.NEWS_TIMEZONE || "Asia/Taipei";
const schedule = process.env.NEWS_CRON || "0 8 * * *";
const isVercel = Boolean(process.env.VERCEL);
const useBlob = Boolean(process.env.BLOB_READ_WRITE_TOKEN);
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const publicDir = path.join(__dirname, "public");
const localDataPath = path.join(publicDir, "data.json");
const blobPath = "ai-daily-news/data.json";
const maxRetries = Number(process.env.GEMINI_MAX_RETRIES || 4);
const retryBaseDelayMs = Number(process.env.GEMINI_RETRY_BASE_DELAY_MS || 5000);

const defaultData = {
  generatedAt: null,
  generatedAtLocal: null,
  last24hWindow: null,
  headline: "AI 每日新聞尚未生成",
  summary: "系統已啟動，等待第一次自動更新。",
  categories: {
    technicalBreakthroughs: [],
    toolApplications: [],
    industryImpact: []
  }
};

const hasGemini = Boolean(process.env.GEMINI_API_KEY);
const genAI = hasGemini ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

let activeRefreshPromise = null;

app.use(express.json());
app.use(express.static(publicDir));

function formatTaipeiTime(date = new Date()) {
  return new Intl.DateTimeFormat("zh-TW", {
    dateStyle: "full",
    timeStyle: "medium",
    timeZone: timezone
  }).format(date);
}

async function ensurePublicDir() {
  await fs.mkdir(publicDir, { recursive: true });
}

async function readLocalJson() {
  try {
    const raw = await fs.readFile(localDataPath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    return { ...defaultData };
  }
}

async function writeLocalJson(payload) {
  await ensurePublicDir();
  await fs.writeFile(localDataPath, JSON.stringify(payload, null, 2), "utf8");
}

async function readBlobJson() {
  const { head } = require("@vercel/blob");

  try {
    const metadata = await head(blobPath, { token: process.env.BLOB_READ_WRITE_TOKEN });
    const response = await fetch(metadata.url, { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Blob fetch failed with ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    return { ...defaultData };
  }
}

async function writeBlobJson(payload) {
  const { put } = require("@vercel/blob");

  await put(blobPath, JSON.stringify(payload, null, 2), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
}

async function readStoredNews() {
  if (useBlob) {
    return readBlobJson();
  }

  return readLocalJson();
}

async function writeStoredNews(payload) {
  if (!isVercel) {
    await writeLocalJson(payload);
  }

  if (useBlob) {
    await writeBlobJson(payload);
    return;
  }

  if (isVercel) {
    throw new Error("Vercel deployment requires BLOB_READ_WRITE_TOKEN or another external datastore.");
  }
}

function buildPrompt() {
  return [
    "你是一個 AI 科技新聞編輯，請搜尋最近 24 小時內與以下主題直接相關的新聞：OpenAI、Anthropic、Google Gemini、Meta AI。",
    "請使用繁體中文輸出，並只保留近 24 小時內的重要消息。",
    "寫作風格要像科技媒體晨報，語氣中性、資訊密度高，避免誇張、煽動、猜測式措辭。",
    "如果估值、投資額、營收、時間或法規內容無法被可靠來源明確支持，就不要寫進去。",
    "若同一事件有多篇報導，請優先選擇可信、資訊最完整的一篇，不要重複。",
    "請將每則新聞歸入以下其中一類：technicalBreakthroughs、toolApplications、industryImpact。",
    "technicalBreakthroughs 代表模型、研究、晶片、推論、基礎能力或技術突破。",
    "toolApplications 代表產品功能、代理工具、工作流程、自動化、API 或企業導入案例。",
    "industryImpact 代表投資、合作、政策、法規、市場競爭、商業策略與產業影響。",
    "每個分類請挑選 2 到 5 則最值得關注的新聞。",
    "每則新聞請包含：title、company、summary、whyItMatters、sourceName、sourceUrl、publishedAt。",
    "title 請精煉到像新聞標題，不要超過 40 個中文字。",
    "summary 請用 1 到 2 句交代事件本身，不要塞太多背景。",
    "whyItMatters 請用 1 句說明對 AI 產業、開發者或市場的重要性。",
    "sourceName 必須是具體媒體、公司官方部落格、官方文件站或研究機構名稱。",
    "sourceUrl 必須是可直接點擊的文章或公告頁，不要填首頁，不要填虛構網址。",
    "publishedAt 請盡量用來源實際發佈時間，格式使用 ISO 8601。",
    "headline 請寫成一句新聞標題，summary 請寫成一段 80 到 140 字的總覽。",
    "如果某分類在近 24 小時內沒有足夠可信消息，陣列可為空，但不要捏造內容。",
    "請只輸出單一 JSON 物件，不要輸出 markdown code fence，不要加前言或結語。",
    `JSON 結構必須完全符合這個樣式：${JSON.stringify({
      headline: "字串",
      summary: "字串",
      categories: {
        technicalBreakthroughs: [
          {
            title: "字串",
            company: "字串",
            summary: "字串",
            whyItMatters: "字串",
            sourceName: "字串",
            sourceUrl: "https://example.com",
            publishedAt: "2026-04-30T08:00:00Z"
          }
        ],
        toolApplications: [],
        industryImpact: []
      }
    })}`
  ].join("\n");
}

function buildSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["headline", "summary", "categories"],
    properties: {
      headline: { type: "string" },
      summary: { type: "string" },
      categories: {
        type: "object",
        additionalProperties: false,
        required: ["technicalBreakthroughs", "toolApplications", "industryImpact"],
        properties: {
          technicalBreakthroughs: buildItemArraySchema(),
          toolApplications: buildItemArraySchema(),
          industryImpact: buildItemArraySchema()
        }
      }
    }
  };
}

function buildItemArraySchema() {
  return {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: [
        "title",
        "company",
        "summary",
        "whyItMatters",
        "sourceName",
        "sourceUrl",
        "publishedAt"
      ],
      properties: {
        title: { type: "string" },
        company: { type: "string" },
        summary: { type: "string" },
        whyItMatters: { type: "string" },
        sourceName: { type: "string" },
        sourceUrl: { type: "string" },
        publishedAt: { type: "string" }
      }
    }
  };
}

function sanitizePayload(payload) {
  return {
    generatedAt: new Date().toISOString(),
    generatedAtLocal: formatTaipeiTime(),
    last24hWindow: "最近 24 小時",
    headline: payload.headline || defaultData.headline,
    summary: payload.summary || defaultData.summary,
    categories: {
      technicalBreakthroughs: normalizeItems(payload.categories?.technicalBreakthroughs || []),
      toolApplications: normalizeItems(payload.categories?.toolApplications || []),
      industryImpact: normalizeItems(payload.categories?.industryImpact || [])
    }
  };
}

function normalizeItems(items) {
  const seen = new Set();

  return items
    .map((item) => ({
      title: String(item.title || "").trim(),
      company: String(item.company || "").trim(),
      summary: String(item.summary || "").trim(),
      whyItMatters: String(item.whyItMatters || "").trim(),
      sourceName: String(item.sourceName || "").trim(),
      sourceUrl: String(item.sourceUrl || "").trim(),
      publishedAt: String(item.publishedAt || "").trim()
    }))
    .filter((item) => item.title && item.summary && item.whyItMatters && item.sourceName && item.sourceUrl)
    .filter((item) => /^https?:\/\//i.test(item.sourceUrl))
    .filter((item) => {
      const key = `${item.title}::${item.sourceUrl}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

function extractJsonObject(text) {
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    const codeFenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeFenceMatch) {
      return JSON.parse(codeFenceMatch[1]);
    }

    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
  }

  throw new Error("Unable to parse Gemini response as JSON.");
}

async function generateNewsDigest() {
  if (!genAI) {
    throw new Error("Missing GEMINI_API_KEY");
  }

  const response = await withRetry(async () => {
    return genAI.models.generateContent({
      model,
      contents: [
        "你是一位嚴謹的科技新聞研究員，回答時要以事實為基礎，避免超出來源內容的推測。",
        buildPrompt()
      ],
      config: {
        tools: [
          {
            googleSearch: {}
          }
        ]
      }
    });
  });

  const parsed = extractJsonObject(response.text);
  return sanitizePayload(parsed);
}

async function withRetry(task) {
  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;

      const retryable = [429, 500, 503].includes(error?.status);
      if (!retryable || attempt === maxRetries) {
        throw error;
      }

      const delayMs = retryBaseDelayMs * attempt;
      console.warn(`Gemini request failed with status ${error.status}. Retrying in ${delayMs}ms (attempt ${attempt}/${maxRetries}).`);
      await sleep(delayMs);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function refreshNews(force = false) {
  if (activeRefreshPromise && !force) {
    return activeRefreshPromise;
  }

  activeRefreshPromise = (async () => {
    const payload = await generateNewsDigest();
    await writeStoredNews(payload);
    return payload;
  })();

  try {
    return await activeRefreshPromise;
  } finally {
    activeRefreshPromise = null;
  }
}

async function refreshIfStale() {
  const current = await readStoredNews();

  if (!current.generatedAt && hasGemini) {
    return refreshNews();
  }

  if (!current.generatedAt) {
    return current;
  }

  const ageMs = Date.now() - new Date(current.generatedAt).getTime();
  const isOlderThan18Hours = ageMs > 18 * 60 * 60 * 1000;

  if (isOlderThan18Hours && hasGemini) {
    return refreshNews();
  }

  return current;
}

function startLocalScheduler() {
  if (isVercel || !hasGemini) {
    return;
  }

  cron.schedule(
    schedule,
    async () => {
      try {
        await refreshNews();
        console.log(`[cron] news refreshed at ${new Date().toISOString()}`);
      } catch (error) {
        console.error("[cron] refresh failed", error);
      }
    },
    { timezone }
  );
}

app.get("/api/health", async (_req, res) => {
  const current = await readStoredNews();
  res.json({
    ok: true,
    storage: useBlob ? "vercel-blob + local cache" : "local-json",
    hasGemini,
    model,
    timezone,
    schedule,
    lastUpdated: current.generatedAt
  });
});

app.get("/api/refresh", async (req, res) => {
  try {
    const authHeader = req.get("authorization");
    const cronSecret = process.env.CRON_SECRET;

    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const payload = await refreshNews();
    return res.json({
      ok: true,
      message: "News refreshed successfully.",
      data: payload
    });
  } catch (error) {
    console.error("Manual refresh failed", error);
    return res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.get("/data.json", async (_req, res) => {
  try {
    const payload = await readStoredNews();
    res.setHeader("Cache-Control", "no-store");
    return res.json(payload);
  } catch (error) {
    return res.status(500).json({
      ...defaultData,
      summary: `讀取資料失敗：${error.message}`
    });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

async function bootstrap() {
  await ensurePublicDir();

  const cliRefresh = process.argv.includes("--refresh");

  if (cliRefresh) {
    try {
      await refreshNews(true);
      console.log("News refresh completed.");
    } catch (error) {
      const existing = await readStoredNews();
      if (existing?.generatedAt) {
        console.warn(`News refresh failed, keeping previous dataset from ${existing.generatedAt}.`);
        console.warn(error.message);
        return { shouldStartServer: false };
      }

      throw error;
    }
    return { shouldStartServer: false };
  }

  try {
    await refreshIfStale();
  } catch (error) {
    console.error("Initial refresh skipped", error.message);
    const existing = await readLocalJson();
    await writeLocalJson(existing);
  }

  startLocalScheduler();
  return { shouldStartServer: true };
}

if (require.main === module) {
  bootstrap()
    .then((result) => {
      if (!result?.shouldStartServer) {
        return;
      }

      app.listen(port, "0.0.0.0", () => {
        console.log(`AI Daily News server running on http://0.0.0.0:${port}`);
      });
    })
    .catch((error) => {
      console.error("Server bootstrap failed", error);
      process.exit(1);
    });
}

module.exports = app;
