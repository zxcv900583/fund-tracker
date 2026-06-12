const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const MAX_SYMBOLS = 20;
const SYMBOL_PATTERN = /^[A-Za-z0-9^=.\-]{1,32}$/;
const ALLOWED_RANGES = new Set([
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
  "max",
]);
const ALLOWED_INTERVALS = new Set(["1d", "1wk", "1mo"]);

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

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }

    const requestUrl = new URL(request.url);

    try {
      if (requestUrl.pathname === "/health") {
        return jsonResponse({
          status: "ok",
          service: "fund-tracker-market-api",
          version: 2,
        });
      }

      if (requestUrl.pathname === "/api/yahoo/quotes") {
        return await handleQuotes(requestUrl);
      }

      if (requestUrl.pathname === "/api/yahoo/chart") {
        return await handleChart(requestUrl);
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

async function handleQuotes(requestUrl) {
  const symbols = parseSymbols(requestUrl.searchParams.get("symbols"));
  const settled = await Promise.allSettled(
    symbols.map((symbol) => fetchYahooJson(symbol, "5d", "1d", 300)),
  );

  const quotes = settled.map((result, index) => {
    const symbol = symbols[index];

    if (result.status === "rejected") {
      return {
        symbol,
        error: result.reason instanceof Error ? result.reason.message : "Unknown error",
      };
    }

    return normalizeQuote(symbol, result.value);
  });

  return jsonResponse({
    quotes,
    fetchedAt: new Date().toISOString(),
  }, 200, "public, max-age=60, s-maxage=300");
}

async function handleChart(requestUrl) {
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
  const upstreamUrl = buildYahooUrl(symbol, range, interval);
  const upstream = await fetch(upstreamUrl, {
    headers: yahooHeaders(),
    cf: {
      cacheEverything: true,
      cacheTtl: range === "1d" || range === "5d" ? 300 : 3600,
    },
  });

  if (!upstream.ok) {
    console.error(JSON.stringify({
      event: "yahoo_chart_failed",
      symbol,
      range,
      interval,
      status: upstream.status,
    }));
    return jsonResponse({ error: `Yahoo Finance HTTP ${upstream.status}` }, 502);
  }

  const headers = new Headers({
    ...CORS_HEADERS,
    ...SECURITY_HEADERS,
    "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
    "Cache-Control": range === "1d" || range === "5d"
      ? "public, max-age=60, s-maxage=300"
      : "public, max-age=300, s-maxage=3600",
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
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

async function fetchYahooJson(symbol, range, interval, cacheTtl) {
  const response = await fetch(buildYahooUrl(symbol, range, interval), {
    headers: yahooHeaders(),
    cf: {
      cacheEverything: true,
      cacheTtl,
    },
  });

  if (!response.ok) {
    throw new Error(`Yahoo Finance HTTP ${response.status}`);
  }

  return await response.json();
}

function buildYahooUrl(symbol, range, interval) {
  const url = new URL(`${YAHOO_CHART_BASE}/${encodeURIComponent(symbol)}`);
  url.searchParams.set("range", range);
  url.searchParams.set("interval", interval);
  url.searchParams.set("includePrePost", "false");
  url.searchParams.set("events", "div,splits");
  return url.toString();
}

function yahooHeaders() {
  return {
    "Accept": "application/json",
    "Accept-Language": "zh-TW,zh;q=0.9,en;q=0.8",
    "User-Agent": "Mozilla/5.0 (compatible; FundTrackerMarketAPI/2.0)",
  };
}

function normalizeQuote(symbol, payload) {
  const result = payload?.chart?.result?.[0];
  if (!result?.meta) {
    return { symbol, error: "No market data" };
  }

  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  const timestamps = result.timestamp || [];
  const validPoints = closes
    .map((value, index) => ({ value, timestamp: timestamps[index] }))
    .filter((point) => Number.isFinite(point.value));
  const latestPoint = validPoints.at(-1);
  const previousPoint = validPoints.at(-2);
  const price = latestPoint?.value;
  const previousClose = previousPoint?.value;

  if (!Number.isFinite(price)) {
    return { symbol, error: "No current price" };
  }

  return {
    symbol,
    price,
    previousClose: Number.isFinite(previousClose) ? previousClose : null,
    currency: meta.currency || null,
    exchange: meta.exchangeName || null,
    marketTime: Number.isFinite(latestPoint?.timestamp) ? latestPoint.timestamp : null,
  };
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
