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
const historyDir = path.join(publicDir, "history");
const historyIndexPath = path.join(historyDir, "index.json");
const blobPath = "ai-daily-news/data.json";
const maxRetries = Number(process.env.GEMINI_MAX_RETRIES || 4);
const retryBaseDelayMs = Number(process.env.GEMINI_RETRY_BASE_DELAY_MS || 5000);
const sourceValidationTimeoutMs = Number(process.env.SOURCE_VALIDATION_TIMEOUT_MS || 8000);
const maxStoryAgeDays = Number(process.env.NEWS_MAX_STORY_AGE_DAYS || 7);
const minimumVisibleStories = Number(process.env.NEWS_MIN_VISIBLE_STORIES || 6);
const allowedSourceHosts = [
  "openai.com",
  "anthropic.com",
  "blog.google",
  "deepmind.google",
  "ai.google.dev",
  "about.fb.com",
  "engineering.fb.com",
  "meta.com",
  "reuters.com",
  "apnews.com",
  "techcrunch.com",
  "theverge.com",
  "wired.com",
  "cnbc.com",
  "bloomberg.com",
  "arstechnica.com",
  "venturebeat.com",
  "techradar.com",
  "seekingalpha.com",
  "cbsnews.com",
  "axios.com",
  "wsj.com",
  "ft.com",
  "forbes.com",
  "technews.tw",
  "ithome.com.tw",
  "inside.com.tw",
  "digitimes.com",
  "money.udn.com",
  "ctee.com.tw",
  "bnext.com.tw",
  "meet.bnext.com.tw",
  "businessweekly.com.tw",
  "36kr.com",
  "36kr.kr"
];

const defaultData = {
  generatedAt: null,
  generatedAtLocal: null,
  last24hWindow: null,
  headline: "AI 每日新聞尚未生成",
  summary: "系統已啟動，等待第一次自動更新。",
  topStories: [],
  focusStories: {
    technicalFocus: null,
    toolFocus: null,
    industryFocus: null
  },
  contextBriefs: {
    topStory: "目前 AI 競爭主軸仍圍繞模型能力、推論成本、企業導入速度與監管調整，沒有明顯新消息時，最值得關注的是各大平台如何把既有模型更穩定地推進到產品與企業工作流程中。",
    technicalFocus: "近期技術競爭重點集中在更高效的推論、更長上下文、更可靠的多模態理解，以及讓模型在成本可控下維持穩定表現。",
    toolFocus: "工具層面的主戰場仍是代理工作流、自動化整合、企業 API 與團隊協作場景，市場正持續從展示型功能轉向可長期落地的生產工具。",
    industryFocus: "產業層面目前最值得追蹤的是雲端平台、模型公司與企業客戶之間的合作方式，以及資本支出、定價策略與法規走向如何影響 AI 商業化。",
    editorPicks: "如果今天缺少密集的新訊號，代表市場可能正處於消化前一輪發布的階段；這時更適合觀察各家公司是否把既有承諾轉成實際產品、合作或採用成果。",
    technicalBreakthroughs: "技術突破的近期主線仍是模型效率、推論延遲、上下文能力與多模態可靠度，這些方向會直接影響下一波產品體驗與部署成本。",
    toolApplications: "工具應用面仍在驗證哪些 AI 功能真的能持續留在工作流程中。從客服、內容生產到企業內部知識工具，重點已經從『能不能做』轉向『能不能穩定用』。",
    industryImpact: "產業影響面目前仍由平台競爭、企業採用速度與監管節奏共同推動。即使當天新聞較少，這三條線仍是判斷市場下一步的核心。"
  },
  categories: {
    technicalBreakthroughs: [],
    toolApplications: [],
    industryImpact: []
  }
};

const hasGemini = Boolean(process.env.GEMINI_API_KEY);
const genAI = hasGemini ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;

let activeRefreshPromise = null;
const storySections = [
  "technicalFocus",
  "toolFocus",
  "industryFocus",
  "technicalBreakthroughs",
  "toolApplications",
  "industryImpact"
];

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
  await fs.mkdir(historyDir, { recursive: true });
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

async function readHistoryIndex() {
  try {
    const raw = await fs.readFile(historyIndexPath, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch (_error) {
    return { items: [] };
  }
}

async function readMostRecentNonEmptyHistorySnapshot() {
  const index = await readHistoryIndex();
  let bestAvailable = null;

  for (const item of index.items || []) {
    if (!item?.path) continue;

    const filename = String(item.path).replace("./history/", "");
    const snapshotPath = path.join(historyDir, filename);

    try {
      const raw = await fs.readFile(snapshotPath, "utf8");
      const parsed = pruneSnapshotStories(JSON.parse(raw));
      const storyCount = countStories(parsed);
      if (!bestAvailable && storyCount > 0) {
        bestAvailable = parsed;
      }
      if (storyCount >= minimumVisibleStories) {
        return parsed;
      }
    } catch (_error) {
      continue;
    }
  }

  return bestAvailable;
}

async function writeHistoryIndex(index) {
  await ensurePublicDir();
  await fs.writeFile(historyIndexPath, JSON.stringify(index, null, 2), "utf8");
}

function formatArchiveDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function formatArchiveTimestamp(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}-${get("minute")}-${get("second")}`;
}

function formatDateForPrompt(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function buildHistoryMeta(payload, archiveKey) {
  const archiveDate = String(payload.generatedAt || "").slice(0, 10) || formatArchiveDate();
  return {
    id: archiveKey,
    date: archiveDate,
    label: payload.generatedAtLocal || archiveDate,
    path: `./history/${archiveKey}.json`,
    headline: payload.headline,
    generatedAt: payload.generatedAt,
    generatedAtLocal: payload.generatedAtLocal
  };
}

async function writeHistorySnapshot(payload) {
  const archiveTimestamp = formatArchiveTimestamp(new Date(payload.generatedAt || Date.now()));
  const archivePath = path.join(historyDir, `${archiveTimestamp}.json`);

  await fs.writeFile(archivePath, JSON.stringify(payload, null, 2), "utf8");

  const index = await readHistoryIndex();
  const nextItems = index.items.filter((item) => item.id !== archiveTimestamp);
  nextItems.unshift(buildHistoryMeta(payload, archiveTimestamp));
  nextItems.sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")));

  await writeHistoryIndex({
    latest: archiveTimestamp,
    items: nextItems
  });
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
  const existing = pruneSnapshotStories(await readStoredNews());
  const payloadStoryCount = countStories(payload);
  const existingStoryCount = countStories(existing);

  if (payloadStoryCount < minimumVisibleStories) {
    if (existingStoryCount >= minimumVisibleStories && existingStoryCount > payloadStoryCount) {
      console.warn(`Generated dataset only had ${payloadStoryCount} visible stories. Keeping richer existing dataset with ${existingStoryCount} stories from ${existing.generatedAt || "unknown time"}.`);
      if (!isVercel) {
        await writeLocalJson(existing);
      }
      return existing;
    }

    if (!isVercel) {
      const fallbackSnapshot = await readMostRecentNonEmptyHistorySnapshot();
      const fallbackCount = countStories(fallbackSnapshot);
      if (fallbackSnapshot && fallbackCount >= minimumVisibleStories && fallbackCount > payloadStoryCount) {
        console.warn(`Generated dataset only had ${payloadStoryCount} visible stories. Restoring fuller recent snapshot with ${fallbackCount} stories from ${fallbackSnapshot.generatedAt || "unknown time"}.`);
        await writeLocalJson(fallbackSnapshot);
        return fallbackSnapshot;
      }
    }
  }

  if (payloadStoryCount === 0 && existingStoryCount > 0) {
    console.warn(`Generated dataset had no visible stories. Keeping previous dataset from ${existing.generatedAt || "unknown time"}.`);
    if (!isVercel) {
      await writeLocalJson(existing);
    }
    return existing;
  }

  if (payloadStoryCount === 0 && existingStoryCount === 0 && !isVercel) {
    const fallbackSnapshot = await readMostRecentNonEmptyHistorySnapshot();
    if (fallbackSnapshot) {
      console.warn(`Generated dataset had no visible stories and current dataset was empty. Restoring latest non-empty history snapshot from ${fallbackSnapshot.generatedAt || "unknown time"}.`);
      await writeLocalJson(fallbackSnapshot);
      return fallbackSnapshot;
    }
  }

  if (!isVercel) {
    await writeLocalJson(payload);
    await writeHistorySnapshot(payload);
  }

  if (useBlob) {
    await writeBlobJson(payload);
    return payload;
  }

  if (isVercel) {
    throw new Error("Vercel deployment requires BLOB_READ_WRITE_TOKEN or another external datastore.");
  }

  return payload;
}

function buildPrompt() {
  const today = formatDateForPrompt(new Date());
  const oldestAllowedDate = formatDateForPrompt(new Date(Date.now() - maxStoryAgeDays * 24 * 60 * 60 * 1000));

  return [
    "你是一個 AI 科技新聞編輯，請整理與以下主題直接相關的最新或近期重要發展：OpenAI、Anthropic、Google Gemini、Meta AI。",
    `今天日期是 ${today}。請優先挑選今天、昨天或最近 3 天內的消息；若真的不足，可放寬到最近 ${maxStoryAgeDays} 天內，但不要使用早於 ${oldestAllowedDate} 的內容。`,
    "你要產出的是一個內容充實的 AI 新知首頁資料池，而不是過度保守的稀疏摘要。",
    "寫作風格要像科技媒體晨報，語氣中性、資訊密度高，避免誇張、煽動、猜測式措辭。",
    "如果估值、投資額、營收、時間或法規內容無法被可靠來源明確支持，就不要寫進去。",
    "若同一事件有多篇報導，請優先選擇可信、資訊最完整的一篇，不要重複。",
    "請不要直接替我分配首頁 topStories、focusStories 或 categories。",
    "請改為輸出一個 stories 陣列，先建立一個足夠大的唯一新聞池，再由系統自行分配到首頁版位。",
    "stories 陣列目標至少 8 則、最好 8 到 12 則，所有故事都必須彼此不同。",
    "每則新聞都必須指定 section，section 只能是以下六種之一：technicalFocus、toolFocus、industryFocus、technicalBreakthroughs、toolApplications、industryImpact。",
    "請盡量讓六種 section 每一種至少出現 1 則，只要近期有可信內容，就不要讓任何 section 缺席。",
    "technicalFocus 代表當前最值得讀者優先理解的技術主線或核心技術事件。",
    "toolFocus 代表當前最值得讀者優先理解的產品、代理工具或應用主線。",
    "industryFocus 代表當前最值得讀者優先理解的商業、合作、投資、法規或市場主線。",
    "technicalBreakthroughs 代表模型、研究、晶片、推論、基礎能力或技術突破。",
    "toolApplications 代表產品功能、代理工具、工作流程、自動化、API 或企業導入案例。",
    "industryImpact 代表投資、合作、政策、法規、市場競爭、商業策略與產業影響。",
    "如果某則內容只是背景整理，不算故事，就不要放進 stories。",
    "你需要以首頁可讀性為優先，寧可選擇近期仍有價值的可信發展，也不要拿太舊的消息硬湊版位。",
    "每則新聞請包含：section、title、company、summary、whyItMatters、sourceName、sourceUrl、publishedAt。",
    "另外請額外提供 contextBriefs 物件，內容是當某個版位或分類缺少足夠可用新聞時，可顯示的背景脈絡摘要。",
    "contextBriefs 每個欄位請用 2 到 4 句繁體中文，清楚說明目前整體發展到哪裡、正在觀察什麼，不要假裝成今天的新訊，也不要寫成空泛口號。",
    "title 請精煉到像新聞標題，不要超過 40 個中文字。",
    "summary 請用 1 到 2 句交代事件本身，不要塞太多背景。",
    "whyItMatters 請用 1 句說明對 AI 產業、開發者或市場的重要性。",
    "sourceName 必須是具體媒體、公司官方部落格、官方文件站或研究機構名稱。",
    "sourceUrl 必須是可直接點擊的原始文章、公告或官方文件頁面，不要填首頁，不要填虛構網址。",
    "sourceUrl 絕對不要使用 Google、Vertex AI Search、grounding-api-redirect 或任何搜尋結果中介跳轉網址。",
    "如果你只能取得中介跳轉網址，請改找原始新聞網站或官方網站的實際頁面連結。",
    "請只使用以下白名單來源或其官方子頁：OpenAI、Anthropic、Google 官方、Meta 官方、Reuters、AP、TechCrunch、The Verge、Wired、CNBC、Bloomberg、Ars Technica、VentureBeat、TechRadar、Seeking Alpha、CBS News、Axios、WSJ、Financial Times、Forbes、TechNews 科技新報、iThome、INSIDE、DIGITIMES、經濟日報、工商時報、數位時代、Meet 創業小聚、商業周刊、36Kr。",
    "不要使用摘要站、轉載站、比價金融站、新聞聚合鏡像站作為 sourceUrl。",
    "publishedAt 請盡量用來源實際發佈時間，格式使用 ISO 8601。",
    "headline 請寫成一句新聞標題，summary 請寫成一段 80 到 140 字的總覽。",
    "請只輸出單一 JSON 物件，不要輸出 markdown code fence，不要加前言或結語。",
    `JSON 結構必須完全符合這個樣式：${JSON.stringify({
      headline: "字串",
      summary: "字串",
      stories: [
        {
          section: "technicalFocus",
          title: "字串",
          company: "字串",
          summary: "字串",
          whyItMatters: "字串",
          sourceName: "字串",
          sourceUrl: "https://example.com",
          publishedAt: "2026-05-01T08:00:00Z"
        }
      ],
      contextBriefs: {
        topStory: "字串",
        technicalFocus: "字串",
        toolFocus: "字串",
        industryFocus: "字串",
        editorPicks: "字串",
        technicalBreakthroughs: "字串",
        toolApplications: "字串",
        industryImpact: "字串"
      }
    })}`
  ].join("\n");
}

function normalizeContextBriefs(contextBriefs = {}) {
  const normalized = {};

  for (const [key, fallback] of Object.entries(defaultData.contextBriefs)) {
    const value = String(contextBriefs[key] || "").trim();
    normalized[key] = value || fallback;
  }

  return normalized;
}

function countStories(payload) {
  const topStories = Array.isArray(payload?.topStories) ? payload.topStories : [];
  const focusStories = payload?.focusStories || {};
  const focusCount = ["technicalFocus", "toolFocus", "industryFocus"].reduce((sum, key) => {
    return focusStories[key] ? sum + 1 : sum;
  }, 0);
  const categories = payload?.categories || {};
  return topStories.length + focusCount + ["technicalBreakthroughs", "toolApplications", "industryImpact"].reduce((sum, key) => {
    const items = Array.isArray(categories[key]) ? categories[key] : [];
    return sum + items.length;
  }, 0);
}

function isRecentStory(item, referenceMs = Date.now()) {
  const publishedMs = Date.parse(String(item?.publishedAt || ""));
  if (!Number.isFinite(publishedMs)) {
    return false;
  }

  const maxAgeMs = maxStoryAgeDays * 24 * 60 * 60 * 1000;
  return publishedMs <= referenceMs && referenceMs - publishedMs <= maxAgeMs;
}

function pruneSnapshotStories(payload) {
  if (!payload || typeof payload !== "object") {
    return { ...defaultData };
  }

  const topStories = (payload.topStories || []).filter((item) => isRecentStory(item));
  const focusStories = {
    technicalFocus: isRecentStory(payload.focusStories?.technicalFocus) ? payload.focusStories.technicalFocus : null,
    toolFocus: isRecentStory(payload.focusStories?.toolFocus) ? payload.focusStories.toolFocus : null,
    industryFocus: isRecentStory(payload.focusStories?.industryFocus) ? payload.focusStories.industryFocus : null
  };
  const categories = {
    technicalBreakthroughs: (payload.categories?.technicalBreakthroughs || []).filter((item) => isRecentStory(item)),
    toolApplications: (payload.categories?.toolApplications || []).filter((item) => isRecentStory(item)),
    industryImpact: (payload.categories?.industryImpact || []).filter((item) => isRecentStory(item))
  };

  return {
    ...payload,
    topStories,
    focusStories,
    categories
  };
}

async function sanitizePayload(payload) {
  const normalizedStories = await normalizeStories(payload.stories || collectLegacyStories(payload));
  const dedupedPayload = assignStoriesToLayout(normalizedStories);

  return {
    generatedAt: new Date().toISOString(),
    generatedAtLocal: formatTaipeiTime(),
    last24hWindow: "近期與最新發展",
    headline: payload.headline || defaultData.headline,
    summary: payload.summary || defaultData.summary,
    topStories: dedupedPayload.topStories,
    focusStories: dedupedPayload.focusStories,
    contextBriefs: normalizeContextBriefs(payload.contextBriefs),
    categories: dedupedPayload.categories
  };
}

function collectLegacyStories(payload = {}) {
  const legacyStories = [];
  const pushLegacy = (item, section) => {
    if (!item) return;
    legacyStories.push({ ...item, section });
  };

  for (const item of payload.topStories || []) {
    pushLegacy(item, "technicalFocus");
  }

  const focusStories = payload.focusStories || {};
  pushLegacy(focusStories.technicalFocus, "technicalFocus");
  pushLegacy(focusStories.toolFocus, "toolFocus");
  pushLegacy(focusStories.industryFocus, "industryFocus");

  for (const item of payload.categories?.technicalBreakthroughs || []) {
    pushLegacy(item, "technicalBreakthroughs");
  }

  for (const item of payload.categories?.toolApplications || []) {
    pushLegacy(item, "toolApplications");
  }

  for (const item of payload.categories?.industryImpact || []) {
    pushLegacy(item, "industryImpact");
  }

  return legacyStories;
}

async function normalizeStories(items) {
  const now = Date.now();
  const maxAgeMs = maxStoryAgeDays * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const normalized = items
    .map((item) => ({
      section: normalizeSection(item.section),
      title: String(item.title || "").trim(),
      company: String(item.company || "").trim(),
      summary: String(item.summary || "").trim(),
      whyItMatters: String(item.whyItMatters || "").trim(),
      sourceName: String(item.sourceName || "").trim(),
      sourceUrl: String(item.sourceUrl || "").trim(),
      publishedAt: String(item.publishedAt || "").trim()
    }))
    .filter((item) => storySections.includes(item.section))
    .filter((item) => item.title && item.summary && item.whyItMatters && item.sourceName && item.sourceUrl && item.publishedAt)
    .filter((item) => /^https?:\/\//i.test(item.sourceUrl))
    .filter((item) => !isBlockedSourceUrl(item.sourceUrl))
    .filter((item) => !isBlockedPublisher(item.sourceUrl))
    .filter((item) => isAllowedSourceUrl(item.sourceUrl))
    .filter((item) => {
      const publishedMs = Date.parse(item.publishedAt);
      return Number.isFinite(publishedMs) && publishedMs <= now && now - publishedMs <= maxAgeMs;
    })
    .filter((item) => {
      const key = `${fingerprint(item.title)}::${fingerprint(item.sourceUrl)}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

  const validated = [];
  for (const item of normalized) {
    if (await isReachableSourceUrl(item.sourceUrl)) {
      validated.push(item);
    }
  }

  return validated.sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

function normalizeSection(section) {
  const value = String(section || "").trim();
  if (storySections.includes(value)) return value;

  const aliasMap = {
    technical: "technicalFocus",
    tools: "toolFocus",
    industry: "industryFocus",
    technicalBreakthrough: "technicalBreakthroughs",
    toolApplication: "toolApplications",
    industryImpact: "industryImpact"
  };

  return aliasMap[value] || value;
}

function assignStoriesToLayout(stories) {
  const buckets = {
    technicalFocus: [],
    toolFocus: [],
    industryFocus: [],
    technicalBreakthroughs: [],
    toolApplications: [],
    industryImpact: []
  };

  for (const story of stories) {
    buckets[story.section].push(stripSection(story));
  }

  const seen = new Set();
  const topStories = [];
  const focusStories = {
    technicalFocus: null,
    toolFocus: null,
    industryFocus: null
  };
  const categories = {
    technicalBreakthroughs: [],
    toolApplications: [],
    industryImpact: []
  };

  const takeNext = (sections) => {
    for (const section of sections) {
      const bucket = buckets[section] || [];
      while (bucket.length) {
        const item = bucket.shift();
        const key = `${fingerprint(item.title)}::${fingerprint(item.sourceUrl || item.company)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        return item;
      }
    }
    return null;
  };

  const withFallbackOrder = (preferredSections) => {
    const allSections = [
      "technicalFocus",
      "toolFocus",
      "industryFocus",
      "technicalBreakthroughs",
      "toolApplications",
      "industryImpact"
    ];
    return [...new Set([...preferredSections, ...allSections])];
  };

  const firstTop = takeNext(["technicalFocus", "toolFocus", "industryFocus", "technicalBreakthroughs", "toolApplications", "industryImpact"]);
  if (firstTop) topStories.push(firstTop);
  const secondTop = takeNext(["industryFocus", "technicalFocus", "toolFocus", "industryImpact", "technicalBreakthroughs", "toolApplications"]);
  if (secondTop) topStories.push(secondTop);

  focusStories.technicalFocus = takeNext(withFallbackOrder(["technicalFocus", "technicalBreakthroughs"]));
  focusStories.toolFocus = takeNext(withFallbackOrder(["toolFocus", "toolApplications"]));
  focusStories.industryFocus = takeNext(withFallbackOrder(["industryFocus", "industryImpact"]));

  categories.technicalBreakthroughs = collectRemaining(buckets, seen, withFallbackOrder(["technicalBreakthroughs", "technicalFocus"]), 3);
  categories.toolApplications = collectRemaining(buckets, seen, withFallbackOrder(["toolApplications", "toolFocus"]), 3);
  categories.industryImpact = collectRemaining(buckets, seen, withFallbackOrder(["industryImpact", "industryFocus"]), 3);

  return {
    topStories,
    focusStories,
    categories
  };
}

function collectRemaining(buckets, seen, sections, limit) {
  const items = [];
  for (const section of sections) {
    const bucket = buckets[section] || [];
    while (bucket.length && items.length < limit) {
      const item = bucket.shift();
      const key = `${fingerprint(item.title)}::${fingerprint(item.sourceUrl || item.company)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
    if (items.length >= limit) break;
  }
  return items;
}

function stripSection(item) {
  const clone = { ...item };
  delete clone.section;
  return clone;
}

function isBlockedSourceUrl(url) {
  const value = String(url || "").toLowerCase();
  return (
    value.includes("vertexaisearch.cloud.google.com") ||
    value.includes("grounding-api-redirect") ||
    value.includes("google.com/url") ||
    value.includes("googleusercontent.com")
  );
}

function isBlockedPublisher(url) {
  const value = String(url || "").toLowerCase();
  return (
    value.includes("biggo.finance") ||
    value.includes("techflowpost.com") ||
    value.includes("newsnow.co.uk")
  );
}

function isAllowedSourceUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return allowedSourceHosts.some((allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`));
  } catch (_error) {
    return false;
  }
}

async function isReachableSourceUrl(url) {
  if (!isAllowedSourceUrl(url) || isBlockedSourceUrl(url) || isBlockedPublisher(url)) {
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), sourceValidationTimeoutMs);

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": "AI-Daily-News-Link-Validator/1.0"
      }
    });

    const finalUrl = response.url || url;
    if (isBlockedSourceUrl(finalUrl) || isBlockedPublisher(finalUrl)) {
      return false;
    }

    if ([401, 403, 405, 406, 409, 429].includes(response.status) && isAllowedSourceUrl(finalUrl)) {
      return true;
    }

    if (!response.ok) {
      return false;
    }

    return true;
  } catch (_error) {
    return isAllowedSourceUrl(url);
  } finally {
    clearTimeout(timeout);
  }
}

function fingerprint(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "");
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
  return await sanitizePayload(parsed);
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
    return await writeStoredNews(payload);
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
