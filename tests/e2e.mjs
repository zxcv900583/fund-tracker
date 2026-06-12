import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const localSite = "http://127.0.0.1:8765/index.html";
const localWorker = "http://127.0.0.1:8790";
const cdpPort = 9225;
const processes = [];
let server = null;
let profileDir = null;
let cdp = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHttp(url, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown error"}`);
}

function startStaticServer() {
  const contentTypes = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".png": "image/png",
  };
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, localSite).pathname);
      if (pathname === "/favicon.ico") {
        response.writeHead(204, { "Cache-Control": "no-store" }).end();
        return;
      }
      const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const resolved = normalize(join(repoRoot, relative));
      if (!resolved.startsWith(repoRoot)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      const body = await readFile(resolved);
      response.writeHead(200, {
        "Content-Type": contentTypes[extname(resolved)] || "application/octet-stream",
        "Cache-Control": "no-store",
      });
      response.end(body);
    } catch (error) {
      console.error(`Static server read failed: ${error.message}`);
      response.writeHead(404).end("Not found");
    }
  });
  return new Promise((resolve) => server.listen(8765, "127.0.0.1", resolve));
}

async function ensureWorker() {
  try {
    const response = await fetch(`${localWorker}/health`);
    if (response.ok) return false;
  } catch (error) {
    console.info(`Local Worker is not running yet: ${error.message}`);
  }
  const executable = process.platform === "win32" ? process.env.ComSpec : "wrangler";
  const args = process.platform === "win32"
    ? ["/d", "/s", "/c", "wrangler.cmd", "dev", "-c", "worker/wrangler.jsonc", "--port", "8790"]
    : ["dev", "-c", "worker/wrangler.jsonc", "--port", "8790"];
  const child = spawn(executable, args, {
    cwd: repoRoot,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  processes.push(child);
  await waitForHttp(`${localWorker}/health`, 60000);
  return true;
}

class CdpClient {
  constructor(webSocketUrl) {
    this.socket = new WebSocket(webSocketUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.socket.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

async function getPageTarget() {
  const response = await waitForHttp(`http://127.0.0.1:${cdpPort}/json/list`);
  const targets = await response.json();
  const target = targets.find((item) => item.type === "page");
  if (!target) throw new Error("Chrome page target not found");
  return target;
}

async function waitForPage(cdp, expression, timeoutMs = 30000) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await cdp.evaluate(expression);
    if (lastValue) return lastValue;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for page condition: ${expression}; last=${JSON.stringify(lastValue)}`);
}

function seedScript() {
  return `(() => {
    const holdings = [
      {
        id:"holding_a", assetType:"fund", fundCode:"F0HKG05X2C", fundName:"統一奔騰基金", currency:"TWD",
        isin:"TW000T0910Y7", dividends:[], rspPlans:[],
        purchases:[{purchaseId:"p1",type:"LUMP",date:"2025-06-12",units:10,navAtPurchase:100,amount:1000,fee:10,note:""}]
      },
      {
        id:"holding_b", assetType:"fund", fundCode:"F0TESTB", fundName:"測試平衡基金", currency:"TWD",
        isin:"", dividends:[], rspPlans:[],
        purchases:[{purchaseId:"p2",type:"LUMP",date:"2025-06-12",units:20,navAtPurchase:50,amount:1000,fee:0,note:""}]
      }
    ];
    const makeHistory = (base, weeklyGain, phase) => {
      const rows = [];
      const start = new Date("2025-05-01T00:00:00Z");
      for (let i=0;i<59;i++) {
        const date = new Date(start.getTime()+i*7*86400000);
        rows.push({
          date:date.toISOString().slice(0,10),
          nav:+(base*(1+i*weeklyGain+Math.sin(i/4+phase)*0.012)).toFixed(4)
        });
      }
      return rows;
    };
    localStorage.clear();
    localStorage.setItem("fund_tracker_holdings", JSON.stringify(holdings));
    localStorage.setItem("fund_tracker_settings", JSON.stringify({
      defaultChartRange:"1Y", currency:"TWD", refreshOnOpen:false, theme:"light",
      marketSymbols:["^GSPC"], compareFundIds:["holding_a","holding_b"], marketRange:"1y"
    }));
    localStorage.setItem("fund_tracker_nav_cache_F0HKG05X2C", JSON.stringify({
      fundCode:"F0HKG05X2C", lastUpdated:new Date().toISOString(),
      source:"test-fixture", navHistory:makeHistory(100,0.003,0)
    }));
    localStorage.setItem("fund_tracker_nav_cache_F0TESTB", JSON.stringify({
      fundCode:"F0TESTB", lastUpdated:new Date().toISOString(),
      source:"test-fixture", navHistory:makeHistory(50,0.0015,1)
    }));
    return true;
  })()`;
}

async function run() {
  console.log("[e2e] starting local services");
  await startStaticServer();
  const spawnedWorker = await ensureWorker();
  profileDir = await mkdtemp(join(tmpdir(), "fund-tracker-e2e-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-extensions",
    "--no-first-run",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    "--window-size=1440,1000",
    "about:blank",
  ], {
    windowsHide: true,
    stdio: "ignore",
  });
  processes.push(chrome);

  const target = await getPageTarget();
  cdp = new CdpClient(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Page.navigate", { url: localSite });
  await sleep(2500);
  await cdp.evaluate(seedScript());
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForPage(cdp, `document.querySelectorAll("#tbody tr").length===2`);
  await sleep(4000);
  console.log("[e2e] initial portfolio loaded");

  const initial = await cdp.evaluate(`({
    marketCards:document.querySelectorAll("[data-market-symbol]").length,
    marketStatus:document.querySelector("#marketStatus")?.textContent,
    tableRows:document.querySelectorAll("#tbody tr").length,
    compareButtons:document.querySelectorAll('button[data-act="cmp"]').length,
    summaryCost:document.querySelector("#sumCost")?.textContent,
    fundChartPoints:chart?.data?.datasets?.[0]?.data?.filter(Number.isFinite).length || 0,
    workerBase:MARKET_API
  })`);
  assert.equal(initial.marketCards, 16);
  assert.equal(initial.tableRows, 2);
  assert.equal(initial.compareButtons, 2);
  assert.match(initial.summaryCost, /2,010/);
  assert.ok(initial.fundChartPoints > 20);
  assert.equal(initial.workerBase, localWorker);

  await cdp.evaluate(`document.querySelector("#btnCompare").click()`);
  await waitForPage(cdp, `marketChart?.data?.datasets?.length===3`, 45000);
  const comparison = await cdp.evaluate(`({
    open:document.querySelector("#dlgMarket").open,
    checkedFunds:document.querySelectorAll("#fundPicker input:checked").length,
    checkedMarkets:document.querySelectorAll("#marketPicker input:checked").length,
    status:document.querySelector("#marketHistoryStatus").textContent,
    labels:marketChart.data.datasets.map(dataset=>dataset.label),
    firstValues:marketChart.data.datasets.map(dataset=>dataset.data.find(Number.isFinite)),
    points:marketChart.data.datasets.map(dataset=>dataset.data.filter(Number.isFinite).length)
  })`);
  assert.equal(comparison.open, true);
  assert.equal(comparison.checkedFunds, 2);
  assert.equal(comparison.checkedMarkets, 1);
  assert.equal(comparison.labels.length, 3);
  assert.ok(comparison.labels.includes("基金 · 統一奔騰基金"));
  assert.ok(comparison.labels.includes("市場 · S&P 500"));
  comparison.firstValues.forEach((value) => assert.ok(Math.abs(value) < 0.000001));
  comparison.points.forEach((count) => assert.ok(count > 20));
  assert.match(comparison.status, /共同起點/);
  console.log("[e2e] fund and market comparison passed");

  await cdp.evaluate(`document.querySelector('#dlgMarket [data-close="dlgMarket"]').click()`);
  await cdp.evaluate(`document.querySelector("#btnAdd").click()`);
  await cdp.evaluate(`(() => {
    const input=document.querySelector("#searchInput");
    input.value="統一奔騰";
    input.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
  await waitForPage(cdp, `document.querySelectorAll("#searchResults .sr-item").length>0`, 30000);
  const fundSearch = await cdp.evaluate(`({
    results:document.querySelectorAll("#searchResults .sr-item").length,
    source:apiDiagnostics.fundSearch
  })`);
  assert.ok(fundSearch.results >= 1);
  assert.match(fundSearch.source, /cloudflare|morningstar/);
  await cdp.evaluate(`document.querySelector("#dlgAdd").close()`);
  console.log("[e2e] fund search passed");

  await cdp.evaluate(`document.querySelector("#btnAddStock").click()`);
  await cdp.evaluate(`(() => {
    const input=document.querySelector("#stockSearchInput");
    input.value="2330";
    input.dispatchEvent(new Event("input",{bubbles:true}));
  })()`);
  await waitForPage(cdp, `document.querySelectorAll("#stockSearchResults [data-stock-i]").length>0`, 30000);
  const stockSearch = await cdp.evaluate(`({
    results:document.querySelectorAll("#stockSearchResults [data-stock-i]").length,
    symbols:document.querySelector("#stockSearchResults")._rows.map(row=>row.symbol),
    selectedName:document.querySelector("#stockSearchResults")._rows.find(row=>row.symbol==="2330.TW")?.name
  })`);
  assert.ok(stockSearch.results >= 1);
  assert.ok(stockSearch.symbols.includes("2330.TW"));
  assert.equal(stockSearch.selectedName, "台積電");
  console.log("[e2e] stock search passed");

  await cdp.evaluate(`(() => {
    const box=document.querySelector("#stockSearchResults");
    const index=box._rows.findIndex(row=>row.symbol==="2330.TW");
    box.querySelector('[data-stock-i="'+index+'"]').click();
  })()`);
  const pickedStock = await cdp.evaluate(`({
    symbol:pickedStock.symbol,
    price:+document.querySelector("#stockPrice").value,
    currency:pickedStock.quote.currency
  })`);
  assert.equal(pickedStock.symbol, "2330.TW");
  assert.ok(pickedStock.price > 0);
  assert.equal(pickedStock.currency, "TWD");

  await cdp.evaluate(`(() => {
    const set=(selector,value)=>{
      const input=document.querySelector(selector);
      input.value=value;
      input.dispatchEvent(new Event("input",{bubbles:true}));
    };
    set("#stockShares","10");
    set("#stockFee","20");
  })()`);
  const stockTotal = await cdp.evaluate(`document.querySelector("#stockTotal").value`);
  assert.match(stockTotal, /TWD/);

  await cdp.evaluate(`document.querySelector("#btnStockConfirm").click()`);
  await waitForPage(cdp, `JSON.parse(localStorage.getItem("fund_tracker_holdings")).length===3`, 30000);
  await waitForPage(cdp, `JSON.parse(localStorage.getItem("fund_tracker_nav_cache_2330.TW")||'{"navHistory":[]}').navHistory.length>20`, 60000);
  await sleep(1000);
  const stockHolding = await cdp.evaluate(`(() => {
    const h=JSON.parse(localStorage.getItem("fund_tracker_holdings")).find(item=>item.symbol==="2330.TW");
    const p=h.purchases[0];
    const row=[...document.querySelectorAll("#tbody tr")].find(tr=>tr.textContent.includes("2330.TW"));
    return {
      assetType:h.assetType,
      shares:p.units,
      price:p.navAtPurchase,
      principal:p.amount,
      fee:p.fee,
      expected:p.units*p.navAtPurchase,
      rowText:row?.textContent||"",
      chartPoints:chart?.data?.datasets?.[0]?.data?.filter(Number.isFinite).length||0
    };
  })()`);
  assert.equal(stockHolding.assetType, "stock");
  assert.equal(stockHolding.shares, 10);
  assert.equal(stockHolding.fee, 20);
  assert.ok(Math.abs(stockHolding.principal - stockHolding.expected) < 0.000001);
  assert.match(stockHolding.rowText, /股票/);
  assert.match(stockHolding.rowText, /2330\.TW/);
  assert.ok(stockHolding.chartPoints > 20);
  console.log("[e2e] stock holding and chart passed");

  await cdp.evaluate(`(() => {
    const h=JSON.parse(localStorage.getItem("fund_tracker_holdings")).find(item=>item.symbol==="2330.TW");
    document.querySelector('button[data-act="mng"][data-id="'+h.id+'"]').click();
  })()`);
  const stockManagement = await cdp.evaluate(`({
    amountLabel:document.querySelector("#eAmtLabel").textContent,
    unitsLabel:document.querySelector("#eUnitsLabel").textContent,
    priceLabel:document.querySelector("#eNavLabel").textContent,
    scheduleHidden:document.querySelector("#rspSection").hidden,
    dividendVisible:!document.querySelector("#divTable").closest("div").hidden
  })`);
  assert.match(stockManagement.amountLabel, /成交金額/);
  assert.equal(stockManagement.unitsLabel, "股數");
  assert.equal(stockManagement.priceLabel, "每股成交價");
  assert.equal(stockManagement.scheduleHidden, true);
  assert.equal(stockManagement.dividendVisible, true);
  await cdp.evaluate(`document.querySelector("#dlgMng").close()`);
  console.log("[e2e] stock management passed");

  await cdp.evaluate(`(() => {
    const h=JSON.parse(localStorage.getItem("fund_tracker_holdings")).find(item=>item.symbol==="2330.TW");
    document.querySelector('button[data-act="cmp"][data-id="'+h.id+'"]').click();
  })()`);
  await waitForPage(cdp, `marketChart?.data?.datasets?.some(dataset=>dataset.label.startsWith("股票 ·"))`, 30000);
  const stockComparison = await cdp.evaluate(`({
    labels:marketChart.data.datasets.map(dataset=>dataset.label),
    checkedFunds:document.querySelectorAll("#fundPicker input:checked").length,
    checkedMarkets:document.querySelectorAll("#marketPicker input:checked").length
  })`);
  assert.ok(stockComparison.labels.some((label) => label.includes("2330")));
  assert.equal(stockComparison.checkedFunds, 3);
  assert.equal(stockComparison.checkedMarkets, 1);
  console.log("[e2e] cross-asset comparison passed");

  const themeBefore = await cdp.evaluate(`document.body.dataset.theme`);
  await cdp.evaluate(`document.querySelector("#dlgMarket").close(); document.querySelector("#btnTheme").click()`);
  const themeAfter = await cdp.evaluate(`document.body.dataset.theme`);
  assert.notEqual(themeBefore, themeAfter);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForPage(cdp, `document.querySelectorAll("#tbody tr").length===3`);
  await cdp.evaluate(`document.querySelector("#btnCompare").click()`);
  await waitForPage(cdp, `marketChart?.data?.datasets?.length>=3`, 30000);
  const mobile = await cdp.evaluate(`({
    viewport:innerWidth,
    bodyWidth:document.body.scrollWidth,
    dialogWidth:Math.round(document.querySelector("#dlgMarket").getBoundingClientRect().width),
    chartWidth:document.querySelector("#marketHistoryChart").width,
    chartHeight:document.querySelector("#marketHistoryChart").height
  })`);
  assert.equal(mobile.viewport, 390);
  assert.equal(mobile.bodyWidth, 390);
  assert.ok(mobile.dialogWidth <= 390);
  assert.ok(mobile.chartWidth > 300);
  assert.ok(mobile.chartHeight > 250);

  const runtimeErrors = cdp.events.filter((event) =>
    event.method === "Runtime.exceptionThrown" ||
    (event.method === "Log.entryAdded" && event.params.entry.level === "error")
  );
  assert.deepEqual(runtimeErrors, []);
  console.log("[e2e] mobile layout and runtime error checks passed");

  console.log(JSON.stringify({
    ok: true,
    spawnedWorker,
    initial,
    comparison,
    fundSearch,
    stockSearch,
    pickedStock,
    stockHolding,
    stockManagement,
    stockComparison,
    mobile,
  }, null, 2));
}

try {
  await run();
} finally {
  if (cdp) {
    cdp.close();
    cdp = null;
  }
  for (const child of processes.reverse()) {
    if (!child.pid) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else if (!child.killed) {
      child.kill("SIGTERM");
    }
  }
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  if (profileDir) {
    await rm(profileDir, { recursive: true, force: true });
  }
}
