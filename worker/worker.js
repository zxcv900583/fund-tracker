const YAHOO_BASES = [
  { url: "https://query1.finance.yahoo.com/v8/finance/chart", name: "yahoo-query1" },
  { url: "https://query2.finance.yahoo.com/v8/finance/chart", name: "yahoo-query2" },
];
const YAHOO_SEARCH_BASES = [
  { url: "https://query1.finance.yahoo.com/v1/finance/search", name: "yahoo-search-query1" },
  { url: "https://query2.finance.yahoo.com/v1/finance/search", name: "yahoo-search-query2" },
];
const TWSE_INDEX_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX";
const TWSE_REALTIME_INDEX_URL = "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0";
const TWSE_HISTORY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_5MINS_HIST";
const TWSE_STOCK_DAILY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
const MORNINGSTAR_BASE = "https://lt.morningstar.com/api/rest.svc";
const MORNINGSTAR_TOKEN = "9vehuxllxs";
const MORNINGSTAR_UNIVERSE = "FOTWN$$ALL";
const TDCC_OFFSHORE_URL = "https://openapi.tdcc.com.tw/v1/opendata/3-4";
const MAX_SYMBOLS = 20;
const SYMBOL_PATTERN = /^[A-Za-z0-9^=.\-]{1,32}$/;
const FUND_ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const ALLOWED_RANGES = new Set([
  "1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max",
]);
const ALLOWED_INTERVALS = new Set(["1d", "1wk", "1mo"]);
const TWSE_FALLBACK_RANGES = new Set(["1d", "5d", "1mo"]);
const KV_TTL_SECONDS = 30 * 24 * 60 * 60;

const INDEX_TIME_ZONES = Object.freeze({
  "^TWII": "Asia/Taipei",
  "^GSPC": "America/New_York",
  "^IXIC": "America/New_York",
  "^DJI": "America/New_York",
  "^N225": "Asia/Tokyo",
  "^HSI": "Asia/Hong_Kong",
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// 瀏覽器請求僅允許本站與本機開發來源；無 Origin（curl/Node）與 file://（"null"）放行，
// 目的是阻擋其他網站把本 Worker 當免費行情 API 嵌用
const PROD_ORIGIN = "https://zxcv900583.github.io";
function isAllowedOrigin(origin) {
  if (!origin || origin === "null") return true;
  try {
    const url = new URL(origin);
    if (url.hostname === "localhost" || url.hostname === "127.0.0.1") return true;
  } catch {
    return false;
  }
  return origin === PROD_ORIGIN;
}

// 每 IP 速率限制（isolate 記憶體版：擋單點濫用；全域防護建議再配 Cloudflare WAF 規則）
const RATE_LIMIT_MAX = 120;       // 一般 API：每 IP 每分鐘
const RATE_LIMIT_DEEP_MAX = 5;    // deep health：每 IP 每分鐘
const rateBuckets = new Map();
function withinRateLimit(request, limit, scope = "") {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = scope + ip;
  const now = Date.now();
  let bucket = rateBuckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    if (rateBuckets.size > 10000) rateBuckets.clear();
    bucket = { count: 0, resetAt: now + 60000 };
    rateBuckets.set(key, bucket);
  }
  bucket.count += 1;
  return bucket.count <= limit;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (!isAllowedOrigin(origin)) {
      return jsonResponse({ error: "Origin not allowed" }, 403);
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    if (!withinRateLimit(request, RATE_LIMIT_MAX)) {
      return jsonResponse({ error: "Too many requests" }, 429);
    }

    const requestUrl = new URL(request.url);

    try {
      if (requestUrl.pathname === "/health") {
        return await handleHealth(requestUrl, env, request);
      }
      if (requestUrl.pathname === "/api/yahoo/quotes") {
        return await handleQuotes(requestUrl, env);
      }
      if (requestUrl.pathname === "/api/yahoo/chart") {
        return await handleChart(requestUrl, env);
      }
      if (requestUrl.pathname === "/api/assets/search") {
        return await handleAssetSearch(requestUrl, env);
      }
      if (requestUrl.pathname === "/api/funds/search") {
        return await handleFundSearch(requestUrl, env);
      }
      if (requestUrl.pathname === "/api/funds/history") {
        return await handleFundHistory(requestUrl, env);
      }
      if (requestUrl.pathname === "/api/funds/tdcc") {
        return await handleTdccNav(requestUrl, env);
      }
      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof HttpError) {
        return jsonResponse(error);
      }
      console.error(JSON.stringify({
        event: "request_failed",
        path: requestUrl.pathname,
        message: error instanceof Error ? error.message : String(error),
      }));
      return jsonResponse({ error: "Upstream market data request failed" }, 502);
    }
  },
};

async function handleHealth(requestUrl, env, request) {
  const base = {
    status: "ok",
    service: "fund-tracker-market-api",
    version: 8,
    cloudflareProxy: true,
    kvConfigured: Boolean(env.MARKET_CACHE),
    fallbackOrder: ["yahoo-query1", "yahoo-query2", "twse-for-taiwan", "cloudflare-kv-stale"],
    fundRoutes: ["morningstar-search", "morningstar-history", "tdcc-offshore"],
    assetRoutes: ["yahoo-search", "yahoo-chart"],
  };

  if (requestUrl.searchParams.get("deep") !== "1") {
    return jsonResponse(base);
  }

  // deep 探測會打 7 個上游＋KV 寫入；設定 HEALTH_KEY（wrangler secret）後需帶 key 才可用
  if (env.HEALTH_KEY && requestUrl.searchParams.get("key") !== env.HEALTH_KEY) {
    throw new HttpError(403, "deep health check requires valid key");
  }
  if (!withinRateLimit(request, RATE_LIMIT_DEEP_MAX, "deep:")) {
    throw new HttpError(429, "Too many deep health checks");
  }

  const checks = await Promise.all([
    probeSource("yahoo-query1", () => fetchYahooFromBase(YAHOO_BASES[0], "^GSPC", "5d", "1d", 60)),
    probeSource("yahoo-query2", () => fetchYahooFromBase(YAHOO_BASES[1], "^GSPC", "5d", "1d", 60)),
    probeSource("twse", fetchTwseQuote),
    probeSource("twse-stock", () => fetchTwseStockQuote("2330.TW")),
    probeSource("yahoo-search", () => fetchYahooSearch("2330.TW")),
    probeSource("morningstar", probeMorningstar),
    probeSource("cloudflare-kv", () => probeKv(env)),
  ]);
  const healthy = checks.filter((check) => check.ok).length;

  return jsonResponse({
    ...base,
    status: healthy >= 2 ? "ok" : healthy === 1 ? "degraded" : "down",
    checkedAt: new Date().toISOString(),
    checks,
  }, healthy ? 200 : 503);
}

async function handleAssetSearch(requestUrl, env) {
  const rawQuery = String(requestUrl.searchParams.get("q") || "").trim();
  if (rawQuery.length < 1 || rawQuery.length > 60) {
    throw new HttpError(400, "q length must be 1-60 characters");
  }
  const queries = normalizeAssetQueries(rawQuery);
  const cacheKey = `asset-search:v4:${encodeURIComponent(rawQuery.toLowerCase())}`;
  const attempts = [];

  for (const query of queries) {
    try {
      const search = await fetchYahooSearch(query, attempts);
      if (search.quotes.length === 0) continue;
      const quotes = await enrichTwseNames(search.quotes);
      const result = {
        query,
        quotes,
        source: `${search.source}-via-cloudflare`,
        stale: false,
        attempts,
        fetchedAt: new Date().toISOString(),
      };
      await putCache(env, cacheKey, result, `as:${quotes.map((quote) => `${quote.symbol}=${quote.name}`).join(",")}`);
      return jsonResponse(result, 200, "public, max-age=60, s-maxage=600");
    } catch (error) {
      attempts.push(`${query}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cached = await getCache(env, cacheKey);
  if (cached?.quotes?.length) {
    return jsonResponse({
      ...cached,
      source: `cloudflare-kv:${cached.source || "yahoo-search"}`,
      stale: true,
      attempts,
    });
  }

  throw new Error(attempts.at(-1) || "No matching stocks or ETFs");
}

async function fetchYahooSearch(query, attempts = []) {
  for (const base of YAHOO_SEARCH_BASES) {
    try {
      const url = new URL(base.url);
      url.searchParams.set("q", query);
      url.searchParams.set("quotesCount", "12");
      url.searchParams.set("newsCount", "0");
      url.searchParams.set("lang", "zh-TW");
      url.searchParams.set("region", "TW");
      const response = await fetch(url, {
        headers: yahooHeaders(),
        cf: { cacheEverything: true, cacheTtl: 600 },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const supportedTypes = new Set(["EQUITY", "ETF"]);
      const quotes = (payload.quotes || [])
        .filter((quote) => supportedTypes.has(quote.quoteType) && SYMBOL_PATTERN.test(quote.symbol || ""))
        .map((quote) => ({
          symbol: quote.symbol,
          name: quote.shortname || quote.longname || quote.symbol,
          shortName: quote.shortname || quote.longname || quote.symbol,
          quoteType: quote.quoteType,
          exchange: quote.exchange || null,
          exchangeDisplay: quote.exchDisp || null,
        }));
      if (quotes.length === 0) {
        attempts.push(`${base.name}: no matching assets`);
        continue;
      }
      return { quotes, source: base.name };
    } catch (error) {
      attempts.push(`${base.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error("Yahoo search providers unavailable");
}

async function enrichTwseNames(quotes) {
  const twseCodes = new Set(
    quotes
      .map((quote) => quote.symbol.match(/^(\d{4,6})\.TW$/)?.[1])
      .filter(Boolean),
  );
  if (twseCodes.size === 0) return quotes;

  try {
    const response = await fetch(TWSE_STOCK_DAILY_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/7.0)",
      },
      cf: { cacheEverything: true, cacheTtl: 300 },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    const names = new Map(
      rows
        .filter((row) => twseCodes.has(row.Code) && String(row.Name || "").trim())
        .map((row) => [row.Code, String(row.Name).trim()]),
    );
    return quotes.map((quote) => {
      const code = quote.symbol.match(/^(\d{4,6})\.TW$/)?.[1];
      return code && names.has(code) ? { ...quote, name: names.get(code) } : quote;
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "twse_name_enrichment_failed",
      message: error instanceof Error ? error.message : String(error),
    }));
    return quotes;
  }
}

async function probeMorningstar() {
  const url = buildMorningstarSearchUrl("統一奔騰", 1);
  const response = await fetch(url, {
    headers: upstreamJsonHeaders(),
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new Error("Morningstar returned no rows");
  }
}

async function probeKv(env) {
  if (!env.MARKET_CACHE) throw new Error("KV binding missing");
  const key = `health:${crypto.randomUUID()}`;
  const value = { ok: true, createdAt: new Date().toISOString() };
  await env.MARKET_CACHE.put(key, JSON.stringify(value), { expirationTtl: 60 });
  const restored = await env.MARKET_CACHE.get(key, "json");
  await env.MARKET_CACHE.delete(key);
  if (!restored?.ok) throw new Error("KV round-trip failed");
}

async function probeSource(name, operation) {
  const startedAt = Date.now();
  try {
    await operation();
    return { name, ok: true, latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      name,
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function handleQuotes(requestUrl, env) {
  const symbols = parseSymbols(requestUrl.searchParams.get("symbols"));
  const settled = await Promise.allSettled(
    symbols.map((symbol) => resolveQuote(symbol, env)),
  );

  const quotes = settled.map((result, index) => {
    const symbol = symbols[index];
    if (result.status === "rejected") {
      return {
        symbol,
        error: result.reason instanceof Error ? result.reason.message : "Unknown error",
      };
    }
    return result.value;
  });
  const sources = [...new Set(
    quotes.filter((quote) => !quote.error).map((quote) => quote.source),
  )];

  return jsonResponse({
    quotes,
    sources,
    fetchedAt: new Date().toISOString(),
  }, 200, "public, max-age=60, s-maxage=300");
}

async function resolveQuote(symbol, env) {
  const attempts = [];

  try {
    const yahoo = await fetchYahooWithFallback(symbol, "5d", "1d", 300, attempts);
    let quote = normalizeQuote(symbol, yahoo.payload);
    let source = yahoo.source;
    if (symbol === "^TWII") {
      try {
        quote = mergeTwseRealtimeQuote(quote, await fetchTwseRealtimeQuote());
        source = "twse";
      } catch (error) {
        attempts.push(`twse-realtime: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const value = { ...quote, source, stale: false, attempts };
    await putCache(env, quoteCacheKey(symbol), value, quoteSignature(quote));
    return value;
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error));
  }

  if (symbol === "^TWII") {
    try {
      const quote = await fetchTwseRealtimeQuote();
      const value = { ...quote, source: "twse", stale: false, attempts };
      await putCache(env, quoteCacheKey(symbol), value, quoteSignature(quote));
      return value;
    } catch (error) {
      attempts.push(`twse-realtime: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const quote = await fetchTwseQuote();
      const value = { ...quote, source: "twse", stale: false, attempts };
      await putCache(env, quoteCacheKey(symbol), value, quoteSignature(quote));
      return value;
    } catch (error) {
      attempts.push(`twse: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (/^\d{4,6}\.TW$/.test(symbol)) {
    try {
      const quote = await fetchTwseStockQuote(symbol);
      const value = { ...quote, source: "twse-stock", stale: false, attempts };
      await putCache(env, quoteCacheKey(symbol), value, quoteSignature(quote));
      return value;
    } catch (error) {
      attempts.push(`twse-stock: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cached = await getCache(env, quoteCacheKey(symbol));
  if (cached && Number.isFinite(cached.price)) {
    return {
      ...cached,
      source: `cloudflare-kv:${cached.source || "unknown"}`,
      stale: true,
      attempts,
    };
  }

  throw new Error(attempts.at(-1) || "No market data");
}

async function handleChart(requestUrl, env) {
  const symbol = parseSymbol(requestUrl.searchParams.get("symbol"));
  const range = parseAllowedValue(
    requestUrl.searchParams.get("range") || "1y",
    ALLOWED_RANGES,
    "range",
  );
  const interval = parseAllowedValue(
    requestUrl.searchParams.get("interval") || "1d",
    ALLOWED_INTERVALS,
    "interval",
  );
  const fresh = requestUrl.searchParams.get("fresh") === "1";
  const attempts = [];
  let chartResult = null;

  try {
    const yahoo = await fetchYahooWithFallback(symbol, range, interval, fresh ? 0 : chartCacheTtl(range), attempts, fresh);
    chartResult = {
      payload: yahoo.payload,
      source: yahoo.source,
      stale: false,
      partial: false,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error));
  }

  if (!chartResult && symbol === "^TWII" && TWSE_FALLBACK_RANGES.has(range)) {
    try {
      chartResult = {
        payload: await fetchTwseHistory(range),
        source: "twse",
        stale: false,
        partial: range === "1mo",
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      attempts.push(`twse: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const cacheKey = chartCacheKey(symbol, range, interval);
  if (chartResult) {
    const timestamps = chartResult.payload?.chart?.result?.[0]?.timestamp || [];
    await putCache(env, cacheKey, chartResult, `c:${timestamps.length}|${timestamps.at(-1) ?? ""}|${chartResult.source}`);
  } else {
    const cached = await getCache(env, cacheKey);
    if (cached?.payload?.chart?.result?.[0]) {
      chartResult = {
        ...cached,
        source: `cloudflare-kv:${cached.source || "unknown"}`,
        stale: true,
      };
    }
  }

  if (!chartResult) {
    throw new Error(attempts.at(-1) || "No chart data");
  }

  return jsonResponse({
    ...chartResult.payload,
    _meta: {
      source: chartResult.source,
      stale: chartResult.stale,
      partial: chartResult.partial,
      fetchedAt: chartResult.fetchedAt,
      attempts,
    },
  }, 200, fresh
    ? "no-store"
    : range === "1d" || range === "5d"
      ? "public, max-age=60, s-maxage=300"
      : "public, max-age=300, s-maxage=3600");
}

async function handleFundSearch(requestUrl, env) {
  const term = String(requestUrl.searchParams.get("term") || "").trim();
  const fresh = requestUrl.searchParams.get("fresh") === "1";
  if (term.length < 2 || term.length > 80) {
    throw new HttpError(400, "term length must be 2-80 characters");
  }
  const cacheKey = `fund-search:v3:${encodeURIComponent(term.toLowerCase())}`;

  try {
    const upstreamUrl = new URL(buildMorningstarSearchUrl(term, 25));
    if (fresh) upstreamUrl.searchParams.set("_fresh", String(Date.now()));
    const response = await fetch(upstreamUrl, {
      headers: {
        ...upstreamJsonHeaders(),
        ...(fresh ? { "Cache-Control": "no-cache" } : {}),
      },
      cf: fresh
        ? { cacheEverything: true, cacheTtl: 0 }
        : { cacheEverything: true, cacheTtl: 3600 },
    });
    if (!response.ok) throw new Error(`Morningstar HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.rows)) throw new Error("Invalid Morningstar search response");
    const result = {
      rows: payload.rows,
      source: "morningstar-via-cloudflare",
      stale: false,
      fetchedAt: new Date().toISOString(),
      fresh,
    };
    const first = payload.rows[0], last = payload.rows.at(-1);
    await putCache(env, cacheKey, result,
      `fs:${payload.rows.length}|${first?.SecId}|${first?.ClosePrice}|${first?.ClosePriceDate}|${last?.SecId}`);
    return jsonResponse(
      result,
      200,
      fresh ? "no-store" : "public, max-age=300, s-maxage=3600",
    );
  } catch (error) {
    const cached = await getCache(env, cacheKey);
    if (cached?.rows) {
      return jsonResponse({
        ...cached,
        source: `cloudflare-kv:${cached.source || "morningstar"}`,
        stale: true,
        fresh: false,
      });
    }
    throw error;
  }
}

async function handleFundHistory(requestUrl, env) {
  const secId = String(requestUrl.searchParams.get("secId") || "").trim();
  const currency = String(requestUrl.searchParams.get("currency") || "").trim().toUpperCase();
  const start = String(requestUrl.searchParams.get("start") || "").trim();
  const end = String(requestUrl.searchParams.get("end") || "").trim();
  const fresh = requestUrl.searchParams.get("fresh") === "1";
  if (!FUND_ID_PATTERN.test(secId)) throw new HttpError(400, "Invalid secId");
  if (currency && !CURRENCY_PATTERN.test(currency)) throw new HttpError(400, "Invalid currency");
  if (!DATE_PATTERN.test(start) || !DATE_PATTERN.test(end) || start > end) {
    throw new HttpError(400, "Invalid date range");
  }
  const cacheKey = `fund-history:v3:${secId}:${currency || "native"}:${start}:${end}`;

  try {
    const upstreamUrl = new URL(buildMorningstarHistoryUrl(secId, currency, start, end));
    if (fresh) upstreamUrl.searchParams.set("_fresh", String(Date.now()));
    const response = await fetch(upstreamUrl, {
      headers: {
        ...upstreamJsonHeaders(),
        ...(fresh ? { "Cache-Control": "no-cache" } : {}),
      },
      cf: fresh
        ? { cacheEverything: true, cacheTtl: 0 }
        : { cacheEverything: true, cacheTtl: 3600 },
    });
    if (!response.ok) throw new Error(`Morningstar HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("Invalid Morningstar history response");
    const history = payload
      .filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[1] > 0);
    if (history.length === 0) throw new Error("Morningstar returned no history");
    const result = {
      history,
      source: "morningstar-via-cloudflare",
      stale: false,
      fetchedAt: new Date().toISOString(),
      fresh,
    };
    await putCache(env, cacheKey, result, `fh:${history.length}|${(history.at(-1) || []).join(":")}`);
    return jsonResponse(
      result,
      200,
      fresh ? "no-store" : "public, max-age=300, s-maxage=3600",
    );
  } catch (error) {
    const cached = await getCache(env, cacheKey);
    if (cached?.history) {
      return jsonResponse({
        ...cached,
        source: `cloudflare-kv:${cached.source || "morningstar"}`,
        stale: true,
        fresh: false,
      });
    }
    throw error;
  }
}

async function handleTdccNav(requestUrl, env) {
  const isin = String(requestUrl.searchParams.get("isin") || "").trim().toUpperCase();
  if (!ISIN_PATTERN.test(isin)) throw new HttpError(400, "Invalid ISIN");
  const cacheKey = `tdcc-nav:v3:${isin}`;

  try {
    const response = await fetch(TDCC_OFFSHORE_URL, {
      headers: upstreamJsonHeaders(),
      cf: { cacheEverything: true, cacheTtl: 21600 },
    });
    if (!response.ok) throw new Error(`TDCC HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Invalid TDCC response");
    const matched = rows
      .filter((row) => row.ISINCODE === isin)
      .sort((a, b) => String(a["日期"] || "").localeCompare(String(b["日期"] || "")));
    const latestRow = matched.at(-1);
    const rawDate = String(latestRow?.["日期"] || "");
    const nav = parseNumber(latestRow?.["基金淨值(金額)"]);
    if (!/^\d{8}$/.test(rawDate) || !Number.isFinite(nav) || nav <= 0) {
      throw new Error("TDCC returned no valid NAV");
    }
    const result = {
      latest: {
        date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
        nav,
      },
      source: "tdcc-via-cloudflare",
      stale: false,
      fetchedAt: new Date().toISOString(),
    };
    await putCache(env, cacheKey, result, `t:${result.latest.date}|${nav}`);
    return jsonResponse(result, 200, "public, max-age=1800, s-maxage=21600");
  } catch (error) {
    const cached = await getCache(env, cacheKey);
    if (cached?.latest) {
      return jsonResponse({
        ...cached,
        source: `cloudflare-kv:${cached.source || "tdcc"}`,
        stale: true,
      });
    }
    throw error;
  }
}

async function fetchYahooWithFallback(symbol, range, interval, cacheTtl, attempts, fresh = false) {
  for (const base of YAHOO_BASES) {
    try {
      return await fetchYahooFromBase(base, symbol, range, interval, cacheTtl, fresh);
    } catch (error) {
      attempts.push(`${base.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error("Yahoo Finance providers unavailable");
}

async function fetchYahooFromBase(base, symbol, range, interval, cacheTtl, fresh = false) {
  const upstreamUrl = new URL(buildYahooUrl(base.url, symbol, range, interval));
  if (fresh) upstreamUrl.searchParams.set("_fresh", String(Date.now()));
  const response = await fetch(upstreamUrl, {
    headers: {
      ...yahooHeaders(),
      ...(fresh ? { "Cache-Control": "no-cache" } : {}),
    },
    cf: {
      cacheEverything: true,
      cacheTtl,
    },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const payload = await response.json();
  if (!payload?.chart?.result?.[0]?.meta) {
    throw new Error(payload?.chart?.error?.description || "Invalid Yahoo response");
  }

  return { payload, source: base.name };
}

async function fetchTwseRealtimeQuote() {
  const response = await fetch(TWSE_REALTIME_INDEX_URL, {
    headers: {
      "Accept": "application/json,text/plain,*/*",
      "Referer": "https://www.twse.com.tw/",
      "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/7.0)",
    },
    cf: { cacheEverything: true, cacheTtl: 5 },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  return normalizeTwseRealtimeQuote(await response.json());
}

function normalizeTwseRealtimeQuote(payload) {
  const row = payload?.msgArray?.find((item) => item?.ch === "t00.tw" || item?.c === "t00");
  const price = parseNumber(row?.z);
  const previousClose = parseNumber(row?.y);
  const marketTime = twseDateTimeToUnix(String(row?.d || row?.["^"] || ""), String(row?.t || row?.["%"] || ""));

  if (!row || !Number.isFinite(price) || !Number.isFinite(previousClose) || !Number.isFinite(marketTime)) {
    throw new Error("TWSE realtime index returned invalid values");
  }

  const session = twseSessionFromDate(String(row.d || row["^"] || ""));
  return {
    symbol: "^TWII",
    price,
    previousClose,
    previousCloseSource: "twse-realtime",
    currency: "TWD",
    exchange: "TWSE",
    marketTime,
    session,
    open: parseNumber(row.o),
    dayHigh: parseNumber(row.h),
    dayLow: parseNumber(row.l),
  };
}

function mergeTwseRealtimeQuote(yahooQuote, twseQuote) {
  const previousCloseOriginal = Number.isFinite(yahooQuote.previousClose)
    ? yahooQuote.previousClose
    : null;

  const merged = {
    ...yahooQuote,
    price: twseQuote.price,
    previousClose: twseQuote.previousClose,
    previousCloseSource: "twse-realtime",
    currency: twseQuote.currency,
    exchange: twseQuote.exchange,
    marketTime: twseQuote.marketTime || yahooQuote.marketTime,
    session: twseQuote.session || yahooQuote.session,
    open: twseQuote.open,
    dayHigh: twseQuote.dayHigh,
    dayLow: twseQuote.dayLow,
    previousCloseMarketDate: marketDateFromUnix(twseQuote.marketTime, "Asia/Taipei"),
  };

  if (Number.isFinite(previousCloseOriginal) && previousCloseOriginal !== twseQuote.previousClose) {
    merged.previousCloseOriginal = previousCloseOriginal;
  } else {
    delete merged.previousCloseOriginal;
  }

  return merged;
}

async function fetchTwseQuote() {
  const response = await fetch(TWSE_INDEX_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/7.0)",
    },
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const rows = await response.json();
  // 以具名欄位存取（實測 schema：日期/指數/收盤指數/漲跌/漲跌點數/漲跌百分比/特殊處理註記）
  const row = rows.find((item) => String(item["指數"] || "").includes("發行量加權"));
  if (!row) throw new Error("TWSE weighted index not found");

  const close = parseNumber(row["收盤指數"]);
  const changePoints = parseNumber(row["漲跌點數"]);
  const sign = String(row["漲跌"] || "").trim() === "-" ? -1 : 1;
  if (!Number.isFinite(close) || !Number.isFinite(changePoints)) {
    throw new Error("TWSE returned invalid index values");
  }

  return {
    symbol: "^TWII",
    price: close,
    previousClose: close - sign * changePoints,
    currency: "TWD",
    exchange: "TWSE",
    marketTime: rocDateToUnix(String(row["日期"] || "")),
  };
}

async function fetchTwseHistory(range) {
  const response = await fetch(TWSE_HISTORY_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/7.0)",
    },
    cf: { cacheEverything: true, cacheTtl: 3600 },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const rows = await response.json();
  let points = rows.map((row) => ({
    timestamp: rocDateToUnix(String(row.Date || "")),
    close: parseNumber(row.ClosingIndex),
  })).filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.close));

  if (range === "1d") points = points.slice(-2);
  if (range === "5d") points = points.slice(-5);
  if (points.length < 2) throw new Error("TWSE history has fewer than two points");

  const closes = points.map((point) => point.close);
  return {
    chart: {
      result: [{
        meta: {
          currency: "TWD",
          symbol: "^TWII",
          exchangeName: "TWSE",
          regularMarketPrice: closes.at(-1),
          chartPreviousClose: closes.at(-2),
        },
        timestamp: points.map((point) => point.timestamp),
        indicators: {
          quote: [{ close: closes }],
          adjclose: [{ adjclose: closes }],
        },
      }],
      error: null,
    },
  };
}

async function fetchTwseStockQuote(symbol) {
  const code = symbol.replace(/\.TW$/, "");
  if (!/^\d{4,6}$/.test(code)) throw new Error("Unsupported TWSE stock symbol");
  const response = await fetch(TWSE_STOCK_DAILY_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/7.0)",
    },
    cf: { cacheEverything: true, cacheTtl: 300 },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const rows = await response.json();
  const row = rows.find((item) => item.Code === code);
  const close = parseNumber(row?.ClosingPrice);
  const change = parseNumber(row?.Change);
  if (!row || !Number.isFinite(close) || close <= 0) {
    throw new Error(`TWSE returned no quote for ${code}`);
  }

  return {
    symbol,
    price: close,
    previousClose: Number.isFinite(change) ? close - change : null,
    currency: "TWD",
    exchange: "TWSE",
    marketTime: rocDateToUnix(String(row.Date || "")),
  };
}

function parseSymbols(rawSymbols) {
  if (!rawSymbols) {
    throw new HttpError(400, "symbols is required");
  }

  const symbols = [...new Set(
    rawSymbols.split(",").map((value) => parseSymbol(value.trim())),
  )];

  if (symbols.length === 0 || symbols.length > MAX_SYMBOLS) {
    throw new HttpError(400, `symbols must contain 1-${MAX_SYMBOLS} items`);
  }

  return symbols;
}

function normalizeAssetQueries(rawQuery) {
  const query = rawQuery.trim().toUpperCase();
  if (/^\d{4,6}$/.test(query)) return [`${query}.TW`, `${query}.TWO`, query];
  return [query];
}

function parseSymbol(rawSymbol) {
  if (!rawSymbol || !SYMBOL_PATTERN.test(rawSymbol)) {
    throw new HttpError(400, "Invalid symbol");
  }
  return rawSymbol;
}

function parseAllowedValue(value, allowedValues, fieldName) {
  if (!allowedValues.has(value)) {
    throw new HttpError(400, `Invalid ${fieldName}`);
  }
  return value;
}

function buildYahooUrl(baseUrl, symbol, range, interval) {
  const url = new URL(`${baseUrl}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");
  return url.toString();
}

function buildMorningstarSearchUrl(term, pageSize) {
  const dataPoints = "SecId|Name|LegalName|ClosePrice|ClosePriceDate|PriceCurrency|ISIN|CategoryName|CustomCategoryId";
  const url = new URL(`${MORNINGSTAR_BASE}/${MORNINGSTAR_TOKEN}/security/screener`);
  url.searchParams.set("page", "1");
  url.searchParams.set("pageSize", String(pageSize));
  url.searchParams.set("sortOrder", "Name asc");
  url.searchParams.set("outputType", "json");
  url.searchParams.set("version", "1");
  url.searchParams.set("languageId", "zh-TW");
  url.searchParams.set("currencyId", "TWD");
  url.searchParams.set("universeIds", MORNINGSTAR_UNIVERSE);
  url.searchParams.set("securityDataPoints", dataPoints);
  url.searchParams.set("term", term);
  return url.toString();
}

function buildMorningstarHistoryUrl(secId, currency, start, end) {
  const morningstarId = `${secId}]2]0]${MORNINGSTAR_UNIVERSE}`;
  const url = new URL(`${MORNINGSTAR_BASE}/timeseries_price/${MORNINGSTAR_TOKEN}`);
  url.searchParams.set("id", morningstarId);
  url.searchParams.set("currencyId", currency);
  url.searchParams.set("idtype", "Morningstar");
  url.searchParams.set("frequency", "daily");
  url.searchParams.set("startDate", start);
  url.searchParams.set("endDate", end);
  url.searchParams.set("outputType", "COMPACTJSON");
  return url.toString();
}

function yahooHeaders() {
  return {
    "Accept": "application/json",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/7.0)",
  };
}

function upstreamJsonHeaders() {
  return {
    "Accept": "application/json",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (compatible; FundTrackerAPI/7.0)",
  };
}

function indexTimeZone(symbol) {
  return INDEX_TIME_ZONES[symbol] || null;
}

function marketDateFromUnix(timestamp, timeZone) {
  if (!Number.isFinite(timestamp) || !timeZone) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp * 1000));

  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  if (!values.year || !values.month || !values.day) return null;
  return `${values.year}-${values.month}-${values.day}`;
}

function alignedPreviousCloseFromDailyKLine(symbol, payload, quoteMarketTime) {
  const timeZone = indexTimeZone(symbol);
  if (!timeZone) return null;

  const result = payload?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const timestamps = result?.timestamp || [];
  const points = timestamps
    .map((timestamp, index) => ({
      close: closes[index],
      timestamp,
      marketDate: marketDateFromUnix(timestamp, timeZone),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && point.marketDate);

  if (points.length < 2) return null;

  const quoteMarketDate = marketDateFromUnix(quoteMarketTime, timeZone);
  const lastPoint = points.at(-1);
  const prevPoint = points.at(-2);

  // Yahoo sometimes returns a daily timestamp for the previous trading day but
  // leaves its OHLC values null.  Do not skip across that null candle: doing so
  // would use an older close (for example Friday instead of Monday) and inflate
  // the displayed percent change.  The immediate previous daily candle must be
  // present and finite before it can become previousClose.
  if (
    !quoteMarketDate ||
    quoteMarketDate !== lastPoint.marketDate ||
    !Number.isFinite(lastPoint.close) ||
    !Number.isFinite(prevPoint.close)
  ) {
    return null;
  }

  return {
    previousClose: prevPoint.close,
    marketDate: quoteMarketDate,
  };
}

function previousCloseFromAlignedDailyKLine(symbol, payload, quoteMarketTime) {
  return alignedPreviousCloseFromDailyKLine(symbol, payload, quoteMarketTime)?.previousClose ?? null;
}

function immediatePreviousKLineClose(symbol, payload) {
  const timeZone = indexTimeZone(symbol);
  if (!timeZone) return null;

  const result = payload?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close || [];
  const timestamps = result?.timestamp || [];
  const points = timestamps
    .map((timestamp, index) => ({
      close: closes[index],
      timestamp,
      marketDate: marketDateFromUnix(timestamp, timeZone),
    }))
    .filter((point) => Number.isFinite(point.timestamp) && point.marketDate);
  const prevPoint = points.at(-2);
  return Number.isFinite(prevPoint?.close) ? prevPoint.close : null;
}

// 盤中以 meta 即時報價、收盤後退回 K 線陣列；前收不再無條件相信 meta.previousClose。
// 對容易發生日線與 quote meta 交易日錯位的主要指數，先用交易所時區確認 quote marketTime
// 與最後一根有效日 K 為同一交易日；只有對齊時才用倒數第二根有效日 K close 當前收。
// 仍不使用 chartPreviousClose（除息/股利調整會使其與當日漲跌計算不一致）。
function normalizeQuote(symbol, payload) {
  const result = payload?.chart?.result?.[0];
  if (!result?.meta) {
    throw new Error("No market data");
  }

  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];

  const validPoints = closes
    .map((value, index) => ({ value, timestamp: timestamps[index] }))
    .filter((point) => Number.isFinite(point.value));

  const lastKLine = validPoints.at(-1) || { value: null, timestamp: 0 };
  const prevKLine = validPoints.at(-2) || { value: null, timestamp: 0 };

  const metaPrice = meta.regularMarketPrice;
  const metaTime = meta.regularMarketTime || 0;

  let finalPrice, finalTime, finalPrevClose;
  let previousCloseSource = null;
  let previousCloseMarketDate = null;
  const previousCloseOriginal = Number.isFinite(meta.previousClose) ? meta.previousClose : null;

  if (Number.isFinite(metaPrice) && metaTime >= lastKLine.timestamp) {
    // 盤中：使用最新的 meta 報價
    finalPrice = metaPrice;
    finalTime = metaTime;
    const alignedPrevClose = alignedPreviousCloseFromDailyKLine(symbol, payload, finalTime);
    if (Number.isFinite(alignedPrevClose?.previousClose)) {
      finalPrevClose = alignedPrevClose.previousClose;
      previousCloseSource = "daily-kline-aligned";
      previousCloseMarketDate = alignedPrevClose.marketDate;
    } else {
      const guardedKLinePreviousClose = indexTimeZone(symbol)
        ? immediatePreviousKLineClose(symbol, payload)
        : prevKLine.value;
      finalPrevClose = meta.previousClose ?? guardedKLinePreviousClose;
      previousCloseSource = Number.isFinite(meta.previousClose) ? "yahoo-meta" : "daily-kline";
    }
  } else if (Number.isFinite(lastKLine.value)) {
    // 收盤後或 meta 延遲：退回最穩定的 K 線陣列
    finalPrice = lastKLine.value;
    finalTime = lastKLine.timestamp;
    finalPrevClose = prevKLine.value;
    previousCloseSource = "daily-kline";
  } else {
    throw new Error("No valid price found");
  }

  // 當日正規交易時段（unix 秒），供前端判斷各市場 交易中／休市（含時區與假日，由 Yahoo 提供）
  const tp = meta.currentTradingPeriod?.regular;
  const session = (tp && Number.isFinite(tp.start) && Number.isFinite(tp.end))
    ? { start: tp.start, end: tp.end }
    : null;

  const quote = {
    symbol,
    price: finalPrice,
    previousClose: Number.isFinite(finalPrevClose) ? finalPrevClose : null,
    previousCloseSource,
    currency: meta.currency || null,
    exchange: meta.exchangeName || null,
    marketTime: finalTime || null,
    session,
  };

  if (previousCloseSource === "daily-kline-aligned" && Number.isFinite(previousCloseOriginal)) {
    quote.previousCloseOriginal = previousCloseOriginal;
  }
  if (previousCloseMarketDate) {
    quote.previousCloseMarketDate = previousCloseMarketDate;
  }

  return quote;
}

function rocDateToUnix(value) {
  if (!/^\d{7}$/.test(value)) return null;
  const year = Number(value.slice(0, 3)) + 1911;
  const month = Number(value.slice(3, 5));
  const day = Number(value.slice(5, 7));
  return Math.floor(Date.UTC(year, month - 1, day, 5, 30) / 1000);
}

function twseDateTimeToUnix(dateValue, timeValue) {
  if (!/^\d{8}$/.test(dateValue) || !/^\d{2}:\d{2}:\d{2}$/.test(timeValue)) return null;
  const year = Number(dateValue.slice(0, 4));
  const month = Number(dateValue.slice(4, 6));
  const day = Number(dateValue.slice(6, 8));
  const [hour, minute, second] = timeValue.split(":").map(Number);
  if (![year, month, day, hour, minute, second].every(Number.isFinite)) return null;

  // Taiwan Stock Exchange timestamps are local Asia/Taipei wall time.  Taiwan
  // has no DST, so subtracting eight hours converts the exchange clock to UTC.
  return Math.floor(Date.UTC(year, month - 1, day, hour - 8, minute, second) / 1000);
}

function twseSessionFromDate(dateValue) {
  const start = twseDateTimeToUnix(dateValue, "09:00:00");
  const end = twseDateTimeToUnix(dateValue, "13:30:00");
  return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
}

function parseNumber(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function chartCacheTtl(range) {
  return range === "1d" || range === "5d" ? 300 : 3600;
}

function quoteCacheKey(symbol) {
  return `quote:v5:${symbol}`;
}

function chartCacheKey(symbol, range, interval) {
  return `chart:v4:${symbol}:${range}:${interval}`;
}

// signature：資料內容簽章。提供時先讀取現值比對，內容未變即略過寫入
// （KV 免費額度寫入僅 1,000/日，讀取 100,000/日，以讀換寫）
async function putCache(env, key, value, signature = null) {
  if (!env.MARKET_CACHE) return;
  try {
    if (signature) {
      const existing = await env.MARKET_CACHE.get(key, "json");
      if (existing?._sig === signature) return;
      value = { ...value, _sig: signature };
    }
    await env.MARKET_CACHE.put(key, JSON.stringify(value), {
      expirationTtl: KV_TTL_SECONDS,
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "kv_put_failed",
      key,
      message: error instanceof Error ? error.message : String(error),
    }));
  }
}

function quoteSignature(quote) {
  return [
    "q",
    quote.price,
    quote.previousClose,
    quote.previousCloseSource ?? "",
    quote.previousCloseOriginal ?? "",
    quote.previousCloseMarketDate ?? "",
    quote.marketTime,
    quote.session?.start ?? "",
  ].join("|");
}

async function getCache(env, key) {
  if (!env.MARKET_CACHE) return null;
  try {
    return await env.MARKET_CACHE.get(key, "json");
  } catch (error) {
    console.error(JSON.stringify({
      event: "kv_get_failed",
      key,
      message: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

function jsonResponse(body, status = 200, cacheControl = "no-store") {
  const errorStatus = body instanceof HttpError ? body.status : null;
  const payload = body instanceof HttpError ? { error: body.message } : body;
  return new Response(JSON.stringify(payload), {
    status: errorStatus || status,
    headers: {
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl,
    },
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export {
  INDEX_TIME_ZONES,
  indexTimeZone,
  marketDateFromUnix,
  normalizeQuote,
  normalizeTwseRealtimeQuote,
  previousCloseFromAlignedDailyKLine,
};
