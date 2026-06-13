import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";

const localBase = "http://127.0.0.1:8790";
const apiBase = process.env.API_BASE || localBase;
let worker = null;
let workerLog = "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    signal: AbortSignal.timeout(options.timeoutMs || 60000),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch (error) {
      throw new Error(`${path} returned invalid JSON: ${error.message}; body=${text.slice(0, 200)}`);
    }
  }
  return { response, body };
}

async function waitForWorker(timeoutMs = 60000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await request("/health", { timeoutMs: 5000 });
      if (result.response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`Local Worker did not start: ${lastError?.message || "unknown"}\n${workerLog.slice(-2000)}`);
}

async function startWorkerIfNeeded() {
  if (apiBase !== localBase) return false;
  try {
    const result = await request("/health", { timeoutMs: 3000 });
    if (result.response.ok) return false;
  } catch (error) {
    console.info(`Local Worker is not running yet: ${error.message}`);
  }

  const executable = process.platform === "win32" ? process.env.ComSpec : "wrangler";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "wrangler.cmd", "dev", "-c", "worker/wrangler.jsonc", "--port", "8790"]
    : ["dev", "-c", "worker/wrangler.jsonc", "--port", "8790"];
  worker = spawn(executable, args, {
    cwd: new URL("..", import.meta.url),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const appendLog = (chunk) => {
    workerLog += chunk.toString();
    if (workerLog.length > 20000) workerLog = workerLog.slice(-20000);
  };
  worker.stdout.on("data", appendLog);
  worker.stderr.on("data", appendLog);
  await waitForWorker();
  return true;
}

function parseChartPoints(payload) {
  const result = payload?.chart?.result?.[0];
  const closes = result?.indicators?.adjclose?.[0]?.adjclose
    || result?.indicators?.quote?.[0]?.close
    || [];
  return closes.filter(Number.isFinite);
}

async function run() {
  const spawnedWorker = await startWorkerIfNeeded();
  console.log(`[api] testing ${apiBase}`);

  const health = await request("/health?deep=1");
  assert.equal(health.response.status, 200);
  assert.equal(health.body.status, "ok");
  assert.equal(health.body.version, 7);
  assert.equal(health.body.cloudflareProxy, true);
  assert.equal(health.body.kvConfigured, true);
  assert.ok(health.body.checks.length >= 7);
  health.body.checks.forEach((check) => assert.equal(check.ok, true, `${check.name}: ${check.error || "failed"}`));

  const assetSearch = await request("/api/assets/search?q=2330");
  assert.equal(assetSearch.response.status, 200);
  assert.ok(assetSearch.body.quotes.some((quote) => quote.symbol === "2330.TW"));
  assert.equal(assetSearch.body.quotes.find((quote) => quote.symbol === "2330.TW").name, "台積電");
  assert.match(assetSearch.body.source, /yahoo-search-query[12]|cloudflare-kv/);

  const quoteSymbols = [
    "^TWII", "^GSPC", "^IXIC", "^DJI", "^SOX", "^N225", "^HSI", "000001.SS",
    "^FTSE", "^GDAXI", "^FCHI", "^KS11", "^NSEI", "^STI", "^VIX",
    "2330.TW", "0050.TW", "AAPL", "SPY",
  ];
  const quotes = await request(`/api/yahoo/quotes?symbols=${encodeURIComponent(quoteSymbols.join(","))}`);
  assert.equal(quotes.response.status, 200);
  assert.equal(quotes.body.quotes.length, quoteSymbols.length);
  const quoteErrors = quotes.body.quotes.filter((quote) => quote.error || !(quote.price > 0));
  assert.deepEqual(quoteErrors, []);
  assert.ok(quotes.body.sources.length >= 1);

  const stockChart = await request("/api/yahoo/chart?symbol=2330.TW&range=10y&interval=1wk");
  assert.equal(stockChart.response.status, 200);
  assert.ok(parseChartPoints(stockChart.body).length > 200);
  assert.match(stockChart.body._meta.source, /yahoo-query[12]|cloudflare-kv/);

  const marketChart = await request("/api/yahoo/chart?symbol=%5EGSPC&range=10y&interval=1wk");
  assert.equal(marketChart.response.status, 200);
  assert.ok(parseChartPoints(marketChart.body).length > 200);

  const fundSearch = await request(`/api/funds/search?term=${encodeURIComponent("統一奔騰")}`);
  assert.equal(fundSearch.response.status, 200);
  assert.ok(fundSearch.body.rows.length >= 1);
  assert.match(fundSearch.body.source, /morningstar|cloudflare-kv/);

  const freshFundSearch = await request("/api/funds/search?term=TW000T0363A9&fresh=1");
  assert.equal(freshFundSearch.response.status, 200);
  assert.equal(freshFundSearch.body.fresh, true);
  assert.equal(freshFundSearch.body.stale, false);
  assert.equal(freshFundSearch.response.headers.get("cache-control"), "no-store");
  const exactFund = freshFundSearch.body.rows.find((row) =>
    row.SecId === "F00001DXL2" && row.ISIN === "TW000T0363A9"
  );
  assert.ok(exactFund);
  assert.ok(exactFund.ClosePrice > 0);
  assert.match(exactFund.ClosePriceDate, /^\d{4}-\d{2}-\d{2}$/);

  const fundHistory = await request("/api/funds/history?secId=F0HKG05X2C&currency=TWD&start=2026-01-01&end=2026-06-12");
  assert.equal(fundHistory.response.status, 200);
  assert.ok(fundHistory.body.history.length > 20);
  assert.ok(fundHistory.body.history.every((point) => Array.isArray(point) && point[1] > 0));

  const freshFundHistory = await request("/api/funds/history?secId=F0HKG05X2C&currency=TWD&start=2026-06-01&end=2026-06-12&fresh=1");
  assert.equal(freshFundHistory.response.status, 200);
  assert.equal(freshFundHistory.body.fresh, true);
  assert.equal(freshFundHistory.body.stale, false);
  assert.equal(freshFundHistory.response.headers.get("cache-control"), "no-store");
  assert.ok(freshFundHistory.body.history.at(-1)[0] >= fundHistory.body.history.at(-1)[0]);

  const tdcc = await request("/api/funds/tdcc?isin=LU0820562030", { timeoutMs: 90000 });
  assert.equal(tdcc.response.status, 200);
  assert.ok(tdcc.body.latest.nav > 0);
  assert.match(tdcc.body.latest.date, /^\d{4}-\d{2}-\d{2}$/);

  const cors = await request("/api/yahoo/quotes?symbols=AAPL");
  assert.equal(cors.response.headers.get("access-control-allow-origin"), "*");
  assert.equal(cors.response.headers.get("x-content-type-options"), "nosniff");

  const options = await request("/api/yahoo/quotes", { method: "OPTIONS" });
  assert.equal(options.response.status, 204);
  assert.equal(options.response.headers.get("access-control-allow-origin"), "*");

  // Origin 白名單：站台與本機放行，其他網站 403
  const blockedOrigin = await request("/api/yahoo/quotes?symbols=AAPL", {
    headers: { Origin: "https://evil.example.com" },
  });
  assert.equal(blockedOrigin.response.status, 403);
  const allowedOrigin = await request("/api/yahoo/quotes?symbols=AAPL", {
    headers: { Origin: "https://zxcv900583.github.io" },
  });
  assert.equal(allowedOrigin.response.status, 200);
  const localOrigin = await request("/health", {
    headers: { Origin: "http://127.0.0.1:8765" },
  });
  assert.equal(localOrigin.response.status, 200);

  // chart fresh=1 → 不快取
  const freshChart = await request("/api/yahoo/chart?symbol=AAPL&range=5d&interval=1d&fresh=1");
  assert.equal(freshChart.response.status, 200);
  assert.equal(freshChart.response.headers.get("cache-control"), "no-store");
  assert.ok(parseChartPoints(freshChart.body).length >= 2);

  const invalidCases = [
    ["/api/assets/search?q=", 400],
    ["/api/yahoo/quotes?symbols=../../etc/passwd", 400],
    ["/api/yahoo/chart?symbol=AAPL&range=invalid&interval=1d", 400],
    ["/api/funds/history?secId=bad!&currency=TWD&start=2026-01-01&end=2026-06-12", 400],
  ];
  for (const [path, expectedStatus] of invalidCases) {
    const result = await request(path);
    assert.equal(result.response.status, expectedStatus, path);
    assert.equal(typeof result.body.error, "string");
  }
  const invalidMethod = await request("/health", { method: "POST" });
  assert.equal(invalidMethod.response.status, 405);

  console.log(JSON.stringify({
    ok: true,
    apiBase,
    spawnedWorker,
    healthChecks: health.body.checks.map((check) => ({
      name: check.name,
      latencyMs: check.latencyMs,
    })),
    assetSearch: {
      source: assetSearch.body.source,
      symbols: assetSearch.body.quotes.map((quote) => quote.symbol),
    },
    quotes: {
      count: quotes.body.quotes.length,
      sources: quotes.body.sources,
    },
    charts: {
      stockPoints: parseChartPoints(stockChart.body).length,
      marketPoints: parseChartPoints(marketChart.body).length,
    },
    fund: {
      searchRows: fundSearch.body.rows.length,
      freshSearchDate: exactFund.ClosePriceDate,
      historyPoints: fundHistory.body.history.length,
      freshLatestDate: new Date(freshFundHistory.body.history.at(-1)[0]).toISOString().slice(0, 10),
      tdccDate: tdcc.body.latest.date,
    },
  }, null, 2));
}

try {
  await run();
} finally {
  if (worker?.pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(worker.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else if (!worker.killed) {
      worker.kill("SIGTERM");
    }
  }
}
