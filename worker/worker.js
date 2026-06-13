var YAHOO_BASES = [
  { url: "https://query1.finance.yahoo.com/v8/finance/chart", name: "yahoo-query1" },
  { url: "https://query2.finance.yahoo.com/v8/finance/chart", name: "yahoo-query2" }
];
var YAHOO_SEARCH_BASES = [
  { url: "https://query1.finance.yahoo.com/v1/finance/search", name: "yahoo-search-query1" },
  { url: "https://query2.finance.yahoo.com/v1/finance/search", name: "yahoo-search-query2" }
];
var TWSE_INDEX_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX";
var TWSE_HISTORY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/MI_5MINS_HIST";
var TWSE_STOCK_DAILY_URL = "https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL";
var MORNINGSTAR_BASE = "https://lt.morningstar.com/api/rest.svc";
var MORNINGSTAR_TOKEN = "9vehuxllxs";
var MORNINGSTAR_UNIVERSE = "FOTWN$$ALL";
var TDCC_OFFSHORE_URL = "https://openapi.tdcc.com.tw/v1/opendata/3-4";
var MAX_SYMBOLS = 20;
var SYMBOL_PATTERN = /^[A-Za-z0-9^=.\-]{1,32}$/;
var FUND_ID_PATTERN = /^[A-Za-z0-9]{1,32}$/;
var CURRENCY_PATTERN = /^[A-Z]{3}$/;
var DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
var ISIN_PATTERN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
var ALLOWED_RANGES = /* @__PURE__ */ new Set([
  "1d",
  "5d",
  "1mo",
  "3mo",
  "6mo",
  "1y",
  "2y",
  "5y",
  "10y",
  "ytd",
  "max"
]);
var ALLOWED_INTERVALS = /* @__PURE__ */ new Set(["1d", "1wk", "1mo"]);
var TWSE_FALLBACK_RANGES = /* @__PURE__ */ new Set(["1d", "5d", "1mo"]);
var KV_TTL_SECONDS = 30 * 24 * 60 * 60;
var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};
var SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer"
};
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    const requestUrl = new URL(request.url);
    try {
      if (requestUrl.pathname === "/health") {
        return await handleHealth(requestUrl, env);
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
        message: error instanceof Error ? error.message : String(error)
      }));
      return jsonResponse({ error: "Upstream market data request failed" }, 502);
    }
  }
};
async function handleHealth(requestUrl, env) {
  const base = {
    status: "ok",
    service: "fund-tracker-market-api",
    version: 6,
    cloudflareProxy: true,
    kvConfigured: Boolean(env.MARKET_CACHE),
    fallbackOrder: ["yahoo-query1", "yahoo-query2", "twse-for-taiwan", "cloudflare-kv-stale"],
    fundRoutes: ["morningstar-search", "morningstar-history", "tdcc-offshore"],
    assetRoutes: ["yahoo-search", "yahoo-chart"]
  };
  if (requestUrl.searchParams.get("deep") !== "1") {
    return jsonResponse(base);
  }
  const checks = await Promise.all([
    probeSource("yahoo-query1", () => fetchYahooFromBase(YAHOO_BASES[0], "^GSPC", "5d", "1d", 60)),
    probeSource("yahoo-query2", () => fetchYahooFromBase(YAHOO_BASES[1], "^GSPC", "5d", "1d", 60)),
    probeSource("twse", fetchTwseQuote),
    probeSource("twse-stock", () => fetchTwseStockQuote("2330.TW")),
    probeSource("yahoo-search", () => fetchYahooSearch("2330.TW")),
    probeSource("morningstar", probeMorningstar),
    probeSource("cloudflare-kv", () => probeKv(env))
  ]);
  const healthy = checks.filter((check) => check.ok).length;
  return jsonResponse({
    ...base,
    status: healthy >= 2 ? "ok" : healthy === 1 ? "degraded" : "down",
    checkedAt: (/* @__PURE__ */ new Date()).toISOString(),
    checks
  }, healthy ? 200 : 503);
}
__name(handleHealth, "handleHealth");
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
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await putCache(env, cacheKey, result);
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
      attempts
    });
  }
  throw new Error(attempts.at(-1) || "No matching stocks or ETFs");
}
__name(handleAssetSearch, "handleAssetSearch");
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
        cf: { cacheEverything: true, cacheTtl: 600 }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const supportedTypes = /* @__PURE__ */ new Set(["EQUITY", "ETF"]);
      const quotes = (payload.quotes || []).filter((quote) => supportedTypes.has(quote.quoteType) && SYMBOL_PATTERN.test(quote.symbol || "")).map((quote) => ({
        symbol: quote.symbol,
        name: quote.shortname || quote.longname || quote.symbol,
        shortName: quote.shortname || quote.longname || quote.symbol,
        quoteType: quote.quoteType,
        exchange: quote.exchange || null,
        exchangeDisplay: quote.exchDisp || null
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
__name(fetchYahooSearch, "fetchYahooSearch");
async function enrichTwseNames(quotes) {
  const twseCodes = new Set(
    quotes.map((quote) => quote.symbol.match(/^(\d{4,6})\.TW$/)?.[1]).filter(Boolean)
  );
  if (twseCodes.size === 0) return quotes;
  try {
    const response = await fetch(TWSE_STOCK_DAILY_URL, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/6.0)"
      },
      cf: { cacheEverything: true, cacheTtl: 300 }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const rows = await response.json();
    const names = new Map(
      rows.filter((row) => twseCodes.has(row.Code) && String(row.Name || "").trim()).map((row) => [row.Code, String(row.Name).trim()])
    );
    return quotes.map((quote) => {
      const code = quote.symbol.match(/^(\d{4,6})\.TW$/)?.[1];
      return code && names.has(code) ? { ...quote, name: names.get(code) } : quote;
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "twse_name_enrichment_failed",
      message: error instanceof Error ? error.message : String(error)
    }));
    return quotes;
  }
}
__name(enrichTwseNames, "enrichTwseNames");
async function probeMorningstar() {
  const url = buildMorningstarSearchUrl("\u7D71\u4E00\u5954\u9A30", 1);
  const response = await fetch(url, {
    headers: upstreamJsonHeaders(),
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.rows) || payload.rows.length === 0) {
    throw new Error("Morningstar returned no rows");
  }
}
__name(probeMorningstar, "probeMorningstar");
async function probeKv(env) {
  if (!env.MARKET_CACHE) throw new Error("KV binding missing");
  const key = `health:${crypto.randomUUID()}`;
  const value = { ok: true, createdAt: (/* @__PURE__ */ new Date()).toISOString() };
  await env.MARKET_CACHE.put(key, JSON.stringify(value), { expirationTtl: 60 });
  const restored = await env.MARKET_CACHE.get(key, "json");
  await env.MARKET_CACHE.delete(key);
  if (!restored?.ok) throw new Error("KV round-trip failed");
}
__name(probeKv, "probeKv");
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
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
__name(probeSource, "probeSource");
async function handleQuotes(requestUrl, env) {
  const symbols = parseSymbols(requestUrl.searchParams.get("symbols"));
  const settled = await Promise.allSettled(
    symbols.map((symbol) => resolveQuote(symbol, env))
  );
  const quotes = settled.map((result, index) => {
    const symbol = symbols[index];
    if (result.status === "rejected") {
      return {
        symbol,
        error: result.reason instanceof Error ? result.reason.message : "Unknown error"
      };
    }
    return result.value;
  });
  const sources = [...new Set(
    quotes.filter((quote) => !quote.error).map((quote) => quote.source)
  )];
  return jsonResponse({
    quotes,
    sources,
    fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
  }, 200, "public, max-age=60, s-maxage=300");
}
__name(handleQuotes, "handleQuotes");
async function resolveQuote(symbol, env) {
  const attempts = [];
  try {
    const yahoo = await fetchYahooWithFallback(symbol, "5d", "1d", 300, attempts);
    const quote = normalizeQuote(symbol, yahoo.payload);
    const value = {
      ...quote,
      source: yahoo.source,
      stale: false,
      attempts
    };
    await putCache(env, quoteCacheKey(symbol), value);
    return value;
  } catch (error) {
    attempts.push(error instanceof Error ? error.message : String(error));
  }
  if (symbol === "^TWII") {
    try {
      const value = {
        ...await fetchTwseQuote(),
        source: "twse",
        stale: false,
        attempts
      };
      await putCache(env, quoteCacheKey(symbol), value);
      return value;
    } catch (error) {
      attempts.push(`twse: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (/^\d{4,6}\.TW$/.test(symbol)) {
    try {
      const value = {
        ...await fetchTwseStockQuote(symbol),
        source: "twse-stock",
        stale: false,
        attempts
      };
      await putCache(env, quoteCacheKey(symbol), value);
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
      attempts
    };
  }
  throw new Error(attempts.at(-1) || "No market data");
}
__name(resolveQuote, "resolveQuote");
async function handleChart(requestUrl, env) {
  const symbol = parseSymbol(requestUrl.searchParams.get("symbol"));
  const range = parseAllowedValue(
    requestUrl.searchParams.get("range") || "1y",
    ALLOWED_RANGES,
    "range"
  );
  const interval = parseAllowedValue(
    requestUrl.searchParams.get("interval") || "1d",
    ALLOWED_INTERVALS,
    "interval"
  );
  const attempts = [];
  let chartResult = null;
  try {
    const yahoo = await fetchYahooWithFallback(symbol, range, interval, chartCacheTtl(range), attempts);
    chartResult = {
      payload: yahoo.payload,
      source: yahoo.source,
      stale: false,
      partial: false,
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
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
        fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
    } catch (error) {
      attempts.push(`twse: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const cacheKey = chartCacheKey(symbol, range, interval);
  if (chartResult) {
    await putCache(env, cacheKey, chartResult);
  } else {
    const cached = await getCache(env, cacheKey);
    if (cached?.payload?.chart?.result?.[0]) {
      chartResult = {
        ...cached,
        source: `cloudflare-kv:${cached.source || "unknown"}`,
        stale: true
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
      attempts
    }
  }, 200, range === "1d" || range === "5d" ? "public, max-age=60, s-maxage=300" : "public, max-age=300, s-maxage=3600");
}
__name(handleChart, "handleChart");
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
        ...fresh ? { "Cache-Control": "no-cache" } : {}
      },
      cf: fresh ? { cacheEverything: true, cacheTtl: 0 } : { cacheEverything: true, cacheTtl: 3600 }
    });
    if (!response.ok) throw new Error(`Morningstar HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.rows)) throw new Error("Invalid Morningstar search response");
    const result = {
      rows: payload.rows,
      source: "morningstar-via-cloudflare",
      stale: false,
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      fresh
    };
    await putCache(env, cacheKey, result);
    return jsonResponse(
      result,
      200,
      fresh ? "no-store" : "public, max-age=300, s-maxage=3600"
    );
  } catch (error) {
    const cached = await getCache(env, cacheKey);
    if (cached?.rows) {
      return jsonResponse({
        ...cached,
        source: `cloudflare-kv:${cached.source || "morningstar"}`,
        stale: true,
        fresh: false
      });
    }
    throw error;
  }
}
__name(handleFundSearch, "handleFundSearch");
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
        ...fresh ? { "Cache-Control": "no-cache" } : {}
      },
      cf: fresh ? { cacheEverything: true, cacheTtl: 0 } : { cacheEverything: true, cacheTtl: 3600 }
    });
    if (!response.ok) throw new Error(`Morningstar HTTP ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error("Invalid Morningstar history response");
    const history = payload.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]) && point[1] > 0);
    if (history.length === 0) throw new Error("Morningstar returned no history");
    const result = {
      history,
      source: "morningstar-via-cloudflare",
      stale: false,
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString(),
      fresh
    };
    await putCache(env, cacheKey, result);
    return jsonResponse(
      result,
      200,
      fresh ? "no-store" : "public, max-age=300, s-maxage=3600"
    );
  } catch (error) {
    const cached = await getCache(env, cacheKey);
    if (cached?.history) {
      return jsonResponse({
        ...cached,
        source: `cloudflare-kv:${cached.source || "morningstar"}`,
        stale: true,
        fresh: false
      });
    }
    throw error;
  }
}
__name(handleFundHistory, "handleFundHistory");
async function handleTdccNav(requestUrl, env) {
  const isin = String(requestUrl.searchParams.get("isin") || "").trim().toUpperCase();
  if (!ISIN_PATTERN.test(isin)) throw new HttpError(400, "Invalid ISIN");
  const cacheKey = `tdcc-nav:v3:${isin}`;
  try {
    const response = await fetch(TDCC_OFFSHORE_URL, {
      headers: upstreamJsonHeaders(),
      cf: { cacheEverything: true, cacheTtl: 21600 }
    });
    if (!response.ok) throw new Error(`TDCC HTTP ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error("Invalid TDCC response");
    const matched = rows.filter((row) => row.ISINCODE === isin).sort((a, b) => String(a["\u65E5\u671F"] || "").localeCompare(String(b["\u65E5\u671F"] || "")));
    const latestRow = matched.at(-1);
    const rawDate = String(latestRow?.["\u65E5\u671F"] || "");
    const nav = parseNumber(latestRow?.["\u57FA\u91D1\u6DE8\u503C(\u91D1\u984D)"]);
    if (!/^\d{8}$/.test(rawDate) || !Number.isFinite(nav) || nav <= 0) {
      throw new Error("TDCC returned no valid NAV");
    }
    const result = {
      latest: {
        date: `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`,
        nav
      },
      source: "tdcc-via-cloudflare",
      stale: false,
      fetchedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await putCache(env, cacheKey, result);
    return jsonResponse(result, 200, "public, max-age=1800, s-maxage=21600");
  } catch (error) {
    const cached = await getCache(env, cacheKey);
    if (cached?.latest) {
      return jsonResponse({
        ...cached,
        source: `cloudflare-kv:${cached.source || "tdcc"}`,
        stale: true
      });
    }
    throw error;
  }
}
__name(handleTdccNav, "handleTdccNav");
async function fetchYahooWithFallback(symbol, range, interval, cacheTtl, attempts) {
  for (const base of YAHOO_BASES) {
    try {
      return await fetchYahooFromBase(base, symbol, range, interval, cacheTtl);
    } catch (error) {
      attempts.push(`${base.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error("Yahoo Finance providers unavailable");
}
__name(fetchYahooWithFallback, "fetchYahooWithFallback");
async function fetchYahooFromBase(base, symbol, range, interval, cacheTtl) {
  const response = await fetch(buildYahooUrl(base.url, symbol, range, interval), {
    headers: yahooHeaders(),
    cf: {
      cacheEverything: true,
      cacheTtl
    }
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
__name(fetchYahooFromBase, "fetchYahooFromBase");
async function fetchTwseQuote() {
  const response = await fetch(TWSE_INDEX_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/6.0)"
    },
    cf: { cacheEverything: true, cacheTtl: 300 }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rows = await response.json();
  const row = rows.find((item) => String(Object.values(item)[1] || "").includes("\u767C\u884C\u91CF\u52A0\u6B0A"));
  if (!row) throw new Error("TWSE weighted index not found");
  const values = Object.values(row);
  const close = parseNumber(values[2]);
  const changePoints = parseNumber(values[4]);
  const sign = values[3] === "-" ? -1 : 1;
  if (!Number.isFinite(close) || !Number.isFinite(changePoints)) {
    throw new Error("TWSE returned invalid index values");
  }
  return {
    symbol: "^TWII",
    price: close,
    previousClose: close - sign * changePoints,
    currency: "TWD",
    exchange: "TWSE",
    marketTime: rocDateToUnix(String(values[0] || ""))
  };
}
__name(fetchTwseQuote, "fetchTwseQuote");
async function fetchTwseHistory(range) {
  const response = await fetch(TWSE_HISTORY_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/6.0)"
    },
    cf: { cacheEverything: true, cacheTtl: 3600 }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const rows = await response.json();
  let points = rows.map((row) => ({
    timestamp: rocDateToUnix(String(row.Date || "")),
    close: parseNumber(row.ClosingIndex)
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
          chartPreviousClose: closes.at(-2)
        },
        timestamp: points.map((point) => point.timestamp),
        indicators: {
          quote: [{ close: closes }],
          adjclose: [{ adjclose: closes }]
        }
      }],
      error: null
    }
  };
}
__name(fetchTwseHistory, "fetchTwseHistory");
async function fetchTwseStockQuote(symbol) {
  const code = symbol.replace(/\.TW$/, "");
  if (!/^\d{4,6}$/.test(code)) throw new Error("Unsupported TWSE stock symbol");
  const response = await fetch(TWSE_STOCK_DAILY_URL, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/6.0)"
    },
    cf: { cacheEverything: true, cacheTtl: 300 }
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
    marketTime: rocDateToUnix(String(row.Date || ""))
  };
}
__name(fetchTwseStockQuote, "fetchTwseStockQuote");
function parseSymbols(rawSymbols) {
  if (!rawSymbols) {
    throw new HttpError(400, "symbols is required");
  }
  const symbols = [...new Set(
    rawSymbols.split(",").map((value) => parseSymbol(value.trim()))
  )];
  if (symbols.length === 0 || symbols.length > MAX_SYMBOLS) {
    throw new HttpError(400, `symbols must contain 1-${MAX_SYMBOLS} items`);
  }
  return symbols;
}
__name(parseSymbols, "parseSymbols");
function normalizeAssetQueries(rawQuery) {
  const query = rawQuery.trim().toUpperCase();
  if (/^\d{4,6}$/.test(query)) return [`${query}.TW`, `${query}.TWO`, query];
  return [query];
}
__name(normalizeAssetQueries, "normalizeAssetQueries");
function parseSymbol(rawSymbol) {
  if (!rawSymbol || !SYMBOL_PATTERN.test(rawSymbol)) {
    throw new HttpError(400, "Invalid symbol");
  }
  return rawSymbol;
}
__name(parseSymbol, "parseSymbol");
function parseAllowedValue(value, allowedValues, fieldName) {
  if (!allowedValues.has(value)) {
    throw new HttpError(400, `Invalid ${fieldName}`);
  }
  return value;
}
__name(parseAllowedValue, "parseAllowedValue");
function buildYahooUrl(baseUrl, symbol, range, interval) {
  const url = new URL(`${baseUrl}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");
  return url.toString();
}
__name(buildYahooUrl, "buildYahooUrl");
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
__name(buildMorningstarSearchUrl, "buildMorningstarSearchUrl");
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
__name(buildMorningstarHistoryUrl, "buildMorningstarHistoryUrl");
function yahooHeaders() {
  return {
    "Accept": "application/json",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/6.0)"
  };
}
__name(yahooHeaders, "yahooHeaders");
function upstreamJsonHeaders() {
  return {
    "Accept": "application/json",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (compatible; FundTrackerAPI/6.0)"
  };
}
__name(upstreamJsonHeaders, "upstreamJsonHeaders");
function normalizeQuote(symbol, payload) {
  const result = payload?.chart?.result?.[0];
  if (!result?.meta) {
    throw new Error("No market data");
  }

  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];

  // 1. 整理出所有有效的 K 線
  const validPoints = closes
    .map((value, index) => ({ value, timestamp: timestamps[index] }))
    .filter((point) => Number.isFinite(point.value));

  const lastKLine = validPoints.at(-1) || { value: null, timestamp: 0 };
  const prevKLine = validPoints.at(-2) || { value: null, timestamp: 0 };

  // 2. 取得 meta 區塊的即時報價資料
  const metaPrice = meta.regularMarketPrice;
  const metaTime = meta.regularMarketTime || 0;

  let finalPrice, finalTime, finalPrevClose;

  // 3. 比較 meta 和 K線，誰的時間最新就用誰的資料
  if (Number.isFinite(metaPrice) && metaTime >= lastKLine.timestamp) {
    // 盤中狀態：使用最新的 meta
    finalPrice = metaPrice;
    finalTime = metaTime;
    // 🚨 毒瘤已拔除：絕對不能用 chartPreviousClose，只准用 previousClose 或 K線前一天
    finalPrevClose = meta.previousClose ?? prevKLine.value;
  } else if (Number.isFinite(lastKLine.value)) {
    // 收盤後或 meta 延遲時：退回使用最穩定的 K 線陣列
    finalPrice = lastKLine.value;
    finalTime = lastKLine.timestamp;
    finalPrevClose = prevKLine.value;
  } else {
    throw new Error("No valid price found");
  }

  return {
    symbol,
    price: finalPrice,
    previousClose: Number.isFinite(finalPrevClose) ? finalPrevClose : null,
    currency: meta.currency || null,
    exchange: meta.exchangeName || null,
    marketTime: finalTime || null
  };
}
__name(normalizeQuote, "normalizeQuote");
function rocDateToUnix(value) {
  if (!/^\d{7}$/.test(value)) return null;
  const year = Number(value.slice(0, 3)) + 1911;
  const month = Number(value.slice(3, 5));
  const day = Number(value.slice(5, 7));
  return Math.floor(Date.UTC(year, month - 1, day, 5, 30) / 1e3);
}
__name(rocDateToUnix, "rocDateToUnix");
function parseNumber(value) {
  const parsed = Number(String(value ?? "").replaceAll(",", "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}
__name(parseNumber, "parseNumber");
function chartCacheTtl(range) {
  return range === "1d" || range === "5d" ? 300 : 3600;
}
__name(chartCacheTtl, "chartCacheTtl");
function quoteCacheKey(symbol) {
  return `quote:v4:${symbol}`;
}
__name(quoteCacheKey, "quoteCacheKey");
function chartCacheKey(symbol, range, interval) {
  return `chart:v4:${symbol}:${range}:${interval}`;
}
__name(chartCacheKey, "chartCacheKey");
async function putCache(env, key, value) {
  if (!env.MARKET_CACHE) return;
  try {
    await env.MARKET_CACHE.put(key, JSON.stringify(value), {
      expirationTtl: KV_TTL_SECONDS
    });
  } catch (error) {
    console.error(JSON.stringify({
      event: "kv_put_failed",
      key,
      message: error instanceof Error ? error.message : String(error)
    }));
  }
}
__name(putCache, "putCache");
async function getCache(env, key) {
  if (!env.MARKET_CACHE) return null;
  try {
    return await env.MARKET_CACHE.get(key, "json");
  } catch (error) {
    console.error(JSON.stringify({
      event: "kv_get_failed",
      key,
      message: error instanceof Error ? error.message : String(error)
    }));
    return null;
  }
}
__name(getCache, "getCache");
function jsonResponse(body, status = 200, cacheControl = "no-store") {
  const errorStatus = body instanceof HttpError ? body.status : null;
  const payload = body instanceof HttpError ? { error: body.message } : body;
  return new Response(JSON.stringify(payload), {
    status: errorStatus || status,
    headers: {
      ...CORS_HEADERS,
      ...SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": cacheControl
    }
  });
}
__name(jsonResponse, "jsonResponse");
var HttpError = class extends Error {
  static {
    __name(this, "HttpError");
  }
  constructor(status, message) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map