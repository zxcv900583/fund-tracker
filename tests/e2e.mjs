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

async function removeProfileDirectory(path) {
  if (!path) return;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      return;
    } catch (error) {
      if (!["EBUSY", "EPERM", "ENOTEMPTY"].includes(error?.code) || attempt === 5) {
        console.warn(`[e2e] profile cleanup skipped: ${error.message}`);
        return;
      }
      await sleep(attempt * 250);
    }
  }
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
      // 相對日期：歷史鋪到 14 天前為止，確保任何一天執行時 API 都有更新資料可抓
      const rows = [];
      const end = new Date(Date.now() - 14*86400000);
      for (let i=0;i<59;i++) {
        const date = new Date(end.getTime()-(58-i)*7*86400000);
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
      marketSymbols:["^GSPC"], compareFundIds:["holding_a","holding_b"], marketRange:"1y",
      swapGainLossColors:false
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
    taiwanMarketText:document.querySelector('[data-market-symbol="^TWII"]')?.textContent,
    tableRows:document.querySelectorAll("#tbody tr").length,
    compareButtons:document.querySelectorAll('button[data-act="cmp"]').length,
    priceHeading:document.querySelector('th[data-k="nav"]')?.textContent.trim(),
    fundBadges:[...document.querySelectorAll("#tbody tr .badge.FUND")].map(badge=>badge.textContent.trim()),
    hasPriceDateHeading:[...document.querySelectorAll("#fundTable th")].some(th=>th.textContent.includes("價格日")),
    updateButtonsTogether:document.querySelector("#btnRefresh")?.parentElement===document.querySelector("#btnMarketRefresh")?.parentElement,
    shortRanges:[...document.querySelectorAll("#rangeTabs [data-r]")].map(button=>button.dataset.r).filter(value=>["1D","2D","5D","21D"].includes(value)),
    sessionBeforeClose:taiwanSessionStatus(new Date("2026-06-12T05:29:00Z")).label,
    sessionAtClose:taiwanSessionStatus(new Date("2026-06-12T05:30:00Z")).label,
    summaryCost:document.querySelector("#sumCost")?.textContent,
    fundChartPoints:chart?.data?.datasets?.[0]?.data?.filter(Number.isFinite).length || 0,
    workerBase:MARKET_API
  })`);
  assert.equal(initial.marketCards, 15);   // ^TWOII（櫃買）已停用：Yahoo 無穩定報價
  assert.equal(initial.tableRows, 2);
  assert.equal(initial.compareButtons, 2);
  assert.equal(initial.priceHeading, "目前價格");
  assert.deepEqual(initial.fundBadges,["基金","基金"]);
  assert.equal(initial.hasPriceDateHeading, false);
  assert.equal(initial.updateButtonsTogether, true);
  assert.deepEqual(initial.shortRanges, ["1D","2D","5D","21D"]);
  assert.equal(initial.sessionBeforeClose, "交易中");
  assert.equal(initial.sessionAtClose, "已休市");
  assert.match(initial.taiwanMarketText, /交易日/);
  assert.match(initial.summaryCost, /2,010/);
  assert.ok(initial.fundChartPoints > 20);
  assert.equal(initial.workerBase, localWorker);

  const refreshResults = await cdp.evaluate(`updateAll({fresh:true})`);
  const seedEnd = new Date(Date.now() - 14*86400000).toISOString().slice(0,10);
  const today = new Date().toISOString().slice(0,10);
  assert.equal(refreshResults.length,2);
  assert.match(refreshResults[0].latestDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(refreshResults[0].latestDate > seedEnd, `latestDate ${refreshResults[0].latestDate} 應晚於 fixture 結尾 ${seedEnd}`);
  assert.ok(refreshResults[0].latestDate <= today);
  assert.equal(refreshResults[0].changed,true);
  const refreshFeedback = await cdp.evaluate(`({
    status:document.querySelector("#updStatus").textContent,
    toast:document.querySelector("#toast").textContent,
    live:document.querySelector("#toast").getAttribute("aria-live"),
    latestDate:JSON.parse(localStorage.getItem("fund_tracker_nav_cache_F0HKG05X2C")).navHistory.at(-1).date
  })`);
  assert.match(refreshFeedback.status,/基金淨值 \d{2}\/\d{2}/);
  assert.match(refreshFeedback.status,/查詢/);
  assert.match(refreshFeedback.toast,/取得新資料|目前沒有新資料/);
  assert.equal(refreshFeedback.live,"polite");
  assert.equal(refreshFeedback.latestDate,refreshResults[0].latestDate);
  cdp.events.length = 0;
  console.log("[e2e] NAV refresh date and completion feedback passed");

  const latestQuoteReconciliation = await cdp.evaluate(`(async()=>{
    const testHolding = {
      id:"latest_quote_test",
      assetType:"fund",
      fundCode:"F00001DXL2",
      fundName:"第一金台灣核心戰略建設基金",
      currency:"TWD",
      isin:"TW000T0363A9",
      purchases:[],
      dividends:[],
      rspPlans:[]
    };
    const originalHistory = msHistoryResult;
    const originalSearch = msSearchResult;
    navMem[testHolding.fundCode] = {
      fundCode:testHolding.fundCode,
      lastUpdated:new Date().toISOString(),
      source:"test-fixture",
      navHistory:[{date:"2026-06-11",nav:42.02}]
    };
    try{
      msHistoryResult = async()=>({
        history:[{date:"2026-06-11",nav:42.02}],
        source:"morningstar-history-test",
        stale:false,
        fetchedAt:"2026-06-12T14:00:00.000Z",
        fresh:true
      });
      msSearchResult = async()=>({
        rows:[
          {secId:"WRONG",isin:"TW000T0363A9X",nav:999,navDate:"2026-06-12"},
          {secId:"F00001DXL2",isin:"TW000T0363A9",nav:42.8,navDate:"2026-06-12"}
        ],
        source:"morningstar-search-test",
        stale:false,
        fetchedAt:"2026-06-12T14:00:01.000Z",
        fresh:true
      });
      const result = await updateFund(testHolding,{fresh:true});
      const latestPoint = getCache(testHolding).navHistory.at(-1);
      return {result,latestPoint};
    }finally{
      msHistoryResult = originalHistory;
      msSearchResult = originalSearch;
      delete navMem[testHolding.fundCode];
      localStorage.removeItem(navKey(testHolding.fundCode));
    }
  })()`);
  assert.equal(latestQuoteReconciliation.result.ok,true);
  assert.equal(latestQuoteReconciliation.result.latestDate,"2026-06-12");
  assert.equal(latestQuoteReconciliation.result.latestSupplemented,true);
  assert.equal(latestQuoteReconciliation.result.historyLatestDate,"2026-06-11");
  assert.deepEqual(latestQuoteReconciliation.latestPoint,{date:"2026-06-12",nav:42.8});
  console.log("[e2e] latest fund quote reconciliation passed");

  await cdp.evaluate(`document.querySelector("#btnCompareView").click()`);
  await waitForPage(cdp, `chartView==="compare" && chart?.data?.datasets?.length===3`, 45000);
  const comparison = await cdp.evaluate(`({
    panelVisible:!document.querySelector("#comparePanel").hidden,
    rangeTabsHidden:document.querySelector("#rangeTabs").style.display==="none",
    compareBtnOn:document.querySelector("#btnCompareView").classList.contains("on"),
    chartTitle:document.querySelector("#chartTitle").textContent,
    checkedFunds:document.querySelectorAll("#fundPicker input:checked").length,
    checkedMarkets:document.querySelectorAll("#marketPicker input:checked").length,
    status:document.querySelector("#marketHistoryStatus").textContent,
    labels:chart.data.datasets.map(dataset=>dataset.label),
    firstValues:chart.data.datasets.map(dataset=>dataset.data.find(Number.isFinite)),
    points:chart.data.datasets.map(dataset=>dataset.data.filter(Number.isFinite).length)
  })`);
  assert.equal(comparison.panelVisible, true);
  assert.equal(comparison.rangeTabsHidden, true);
  assert.equal(comparison.compareBtnOn, true);
  assert.match(comparison.chartTitle, /比較/);
  assert.equal(comparison.checkedFunds, 2);
  assert.equal(comparison.checkedMarkets, 1);
  assert.equal(comparison.labels.length, 3);
  assert.ok(comparison.labels.includes("基金 · 統一奔騰基金"));
  assert.ok(comparison.labels.includes("市場 · S&P 500"));
  comparison.firstValues.forEach((value) => assert.ok(Math.abs(value) < 0.000001));
  comparison.points.forEach((count) => assert.ok(count > 20));
  assert.match(comparison.status, /共同起點/);
  await cdp.evaluate(`document.querySelector('#marketRanges [data-market-range="1bd"]').click()`);
  await waitForPage(cdp, `chart?.data?.datasets?.length===3 && chart.data.datasets.every(dataset=>dataset.data.filter(Number.isFinite).length===2)`,30000);
  const comparisonBusinessDayPoints = await cdp.evaluate(
    `chart.data.datasets.map(dataset=>dataset.data.filter(Number.isFinite).length)`
  );
  assert.deepEqual(comparisonBusinessDayPoints,[2,2,2]);
  await cdp.evaluate(`document.querySelector('#marketRanges [data-market-range="1y"]').click()`);
  await waitForPage(cdp, `chart?.data?.datasets?.every(dataset=>dataset.data.filter(Number.isFinite).length>20)`,30000);

  // 比較選擇彈窗：點「選擇資產」開窗 → 取消第一檔基金 → 確定 → 走勢少一條
  const beforePickerCount = await cdp.evaluate(`chart.data.datasets.length`);
  await cdp.evaluate(`document.querySelector("#btnComparePick").click()`);
  await waitForPage(cdp, `document.querySelector("#dlgCompare").open===true`);
  const dlgInfo = await cdp.evaluate(`({
    funds:document.querySelectorAll("#dlgCompare input[data-fund-pick]").length,
    markets:document.querySelectorAll("#dlgCompare input[data-market-pick]").length,
    count:document.querySelector("#comparePickCount").textContent,
    hasIncepRange:!!document.querySelector('#marketRanges [data-market-range="incep"]')
  })`);
  assert.ok(dlgInfo.funds >= 2, `彈窗應有基金選項，實際 ${dlgInfo.funds}`);
  assert.equal(dlgInfo.markets, 15);
  assert.match(dlgInfo.count, /已選 \d+\/6/);
  assert.ok(dlgInfo.hasIncepRange, "應有『成立至今』區間鈕");
  // 取消勾選假測試基金 holding_b，留下真實的 holding_a（成立至今才能對真基金抓歷史，不打到不存在的 secId）
  await cdp.evaluate(`(()=>{const cb=document.querySelector('#dlgCompare input[data-fund-pick="holding_b"]');cb.checked=false;cb.dispatchEvent(new Event("change",{bubbles:true}));})()`);
  await cdp.evaluate(`document.querySelector("#btnCompareConfirm").click()`);
  await waitForPage(cdp, `document.querySelector("#dlgCompare").open===false && chart?.data?.datasets?.length===${beforePickerCount - 1}`, 30000);
  // 取消語意：開窗取消勾選但按取消 → 選擇不變
  await cdp.evaluate(`document.querySelector("#btnComparePick").click()`);
  await waitForPage(cdp, `document.querySelector("#dlgCompare").open===true`);
  await cdp.evaluate(`(()=>{const cb=document.querySelector("#dlgCompare input[data-market-pick]:checked");if(cb){cb.checked=false;cb.dispatchEvent(new Event("change",{bubbles:true}));}document.querySelector('#dlgCompare [data-close="dlgCompare"]').click();})()`);
  await waitForPage(cdp, `document.querySelector("#dlgCompare").open===false`);
  const afterCancel = await cdp.evaluate(`chart.data.datasets.length`);
  assert.equal(afterCancel, beforePickerCount - 1, "取消不應改變走勢數");
  // 成立至今：切到 incep 仍有走勢
  await cdp.evaluate(`document.querySelector('#marketRanges [data-market-range="incep"]').click()`);
  await waitForPage(cdp, `marketRange==="incep" && chart?.data?.datasets?.length>=1 && chart.data.datasets.every(d=>d.data.filter(Number.isFinite).length>20)`, 30000);
  await cdp.evaluate(`document.querySelector('#marketRanges [data-market-range="1y"]').click()`);
  await waitForPage(cdp, `marketRange==="1y"`, 30000);
  // 還原比較選擇，供後續跨資產段沿用（避免測試間相依）
  await cdp.evaluate(`(()=>{ compareFundIds=["holding_a","holding_b"]; marketSelection=["^GSPC"]; persistMarketSettings(); })()`);
  console.log("[e2e] fund and market comparison passed (dialog + incep)");

  // 切回單一資產檢視（點表格列），確認比較面板收起
  await cdp.evaluate(`[...document.querySelectorAll("#tbody tr[data-id]")][0].click()`);
  await waitForPage(cdp, `chartView==="fund" && document.querySelector("#comparePanel").hidden`);
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

  // 庫存最新價格須與「搜尋同源」的報價端點一致（修正：更新改用 /api/yahoo/quotes 取最新成交價）
  const stockLatestParity = await cdp.evaluate(`(async()=>{
    const payload = await (await fetch(MARKET_API+"/api/yahoo/quotes?symbols=2330.TW")).json();
    const quote = (payload.quotes||[]).find(q=>q.symbol==="2330.TW");
    const cache = JSON.parse(localStorage.getItem("fund_tracker_nav_cache_2330.TW"));
    const latest = cache.navHistory.at(-1);
    return {quotePrice:quote?.price, holdingLatest:latest?.nav, holdingDate:latest?.date};
  })()`);
  assert.ok(Number.isFinite(stockLatestParity.quotePrice) && stockLatestParity.quotePrice > 0);
  assert.equal(stockLatestParity.holdingLatest, stockLatestParity.quotePrice,
    `庫存最新價 ${stockLatestParity.holdingLatest} 應等於報價端點 ${stockLatestParity.quotePrice}`);
  console.log("[e2e] stock holding and chart passed; latest-price parity:", JSON.stringify(stockLatestParity));

  const shortRangePoints = {};
  for (const [range, expectedPoints] of [["1D",2],["2D",3],["5D",6],["21D",22]]) {
    await cdp.evaluate(`document.querySelector('#rangeTabs [data-r="${range}"]').click()`);
    await waitForPage(cdp, `chart?.data?.datasets?.[0]?.data?.filter(Number.isFinite).length===${expectedPoints}`);
    shortRangePoints[range] = await cdp.evaluate(`chart.data.datasets[0].data.filter(Number.isFinite).length`);
  }
  assert.deepEqual(shortRangePoints, { "1D":2, "2D":3, "5D":6, "21D":22 });
  await cdp.evaluate(`document.querySelector('#rangeTabs [data-r="1Y"]').click()`);
  console.log("[e2e] business-day ranges passed");

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

  // 自動帶入：開啟新增買入即依預設日期預填，改日期則帶入該日快取股價（四捨五入去浮點雜訊，可手動覆寫）
  const autoFill = await cdp.evaluate(`(async()=>{
    document.querySelector("#btnAddPur").click();              // openPurEdit(null)：開啟即靜默預填
    await new Promise(r=>setTimeout(r,150));
    const prefill = document.querySelector("#eNav").value;
    const hist = JSON.parse(localStorage.getItem("fund_tracker_nav_cache_2330.TW")).navHistory;
    const pick = hist[Math.floor(hist.length*0.5)];           // 取快取中段一筆確定存在
    const el = document.querySelector("#eDate");
    el.value = pick.date; el.dispatchEvent(new Event("change",{bubbles:true}));
    await new Promise(r=>setTimeout(r,150));
    return {prefill, pickNav:pick.nav, filled:document.querySelector("#eNav").value};
  })()`);
  const cleanExpect = (v) => +(+v).toFixed(v >= 100 ? 2 : 4);
  const decimals = (s) => (String(s).split(".")[1] || "").length;
  assert.ok(parseFloat(autoFill.prefill) > 0, "開啟新增買入應依預設日期自動預填股價");
  assert.equal(parseFloat(autoFill.filled), cleanExpect(autoFill.pickNav), "選好日期應自動帶入該日快取股價（四捨五入後）");
  assert.ok(decimals(autoFill.filled) <= 4, `自動帶入價不應有浮點雜訊長尾：${autoFill.filled}`);
  assert.ok(decimals(autoFill.prefill) <= 4, `預填價不應有浮點雜訊長尾：${autoFill.prefill}`);
  console.log("[e2e] purchase price auto-fill passed:", JSON.stringify(autoFill));

  // 賣出表單同樣自動帶入當日數值，且去浮點雜訊
  const sellFill = await cdp.evaluate(`(async()=>{
    document.querySelector("#btnAddSell").click();             // openSellEdit(null)：開啟即靜默預填
    await new Promise(r=>setTimeout(r,150));
    const prefill = document.querySelector("#eSellPrice").value;
    const hist = JSON.parse(localStorage.getItem("fund_tracker_nav_cache_2330.TW")).navHistory;
    const pick = hist[Math.floor(hist.length*0.4)];
    const el = document.querySelector("#eSellDate");
    el.value = pick.date; el.dispatchEvent(new Event("change",{bubbles:true}));
    await new Promise(r=>setTimeout(r,150));
    const filled = document.querySelector("#eSellPrice").value;
    document.querySelector("#btnSellCancel").click();          // 不儲存，避免改動持倉
    return {prefill, pickNav:pick.nav, filled};
  })()`);
  assert.ok(parseFloat(sellFill.prefill) > 0, "開啟新增賣出應依預設日期自動預填價格");
  assert.equal(parseFloat(sellFill.filled), cleanExpect(sellFill.pickNav), "賣出選好日期應自動帶入該日快取價（四捨五入後）");
  assert.ok(decimals(sellFill.filled) <= 4, `賣出自動帶入價不應有浮點雜訊長尾：${sellFill.filled}`);
  console.log("[e2e] sell price auto-fill passed:", JSON.stringify(sellFill));

  // 0 股觀察用：可儲存 0 股買入（成本/損益 0、不影響既有持股），驗證後刪除還原
  const watchZero = await cdp.evaluate(`(async()=>{
    const before = totUnits(holdings.find(x=>x.symbol==="2330.TW"));
    document.querySelector("#btnAddPur").click();             // openPurEdit(null)
    await new Promise(r=>setTimeout(r,150));
    document.querySelector("#eUnits").value="0";
    document.querySelector("#eUnits").dispatchEvent(new Event("input",{bubbles:true}));
    await new Promise(r=>setTimeout(r,80));
    const amtField = document.querySelector("#eAmt").value;   // 0 股 → 成交金額空
    document.querySelector("#btnPurSave").click();
    await new Promise(r=>setTimeout(r,150));
    const saved = document.querySelector("#purEdit").hidden;  // 存檔成功才會關閉編輯區
    const h = holdings.find(x=>x.symbol==="2330.TW");
    const zero = h.purchases.find(p=>+p.units===0);
    const after = totUnits(h);
    let restored = after;
    if(zero){                                                 // 還原：刪掉這筆 0 股
      window.confirm = ()=>true;
      const del=[...document.querySelectorAll("#purBody button[data-pdel]")].find(b=>b.dataset.pdel===zero.purchaseId);
      if(del){ del.click(); await new Promise(r=>setTimeout(r,150)); }
      restored = totUnits(holdings.find(x=>x.symbol==="2330.TW"));
    }
    return {before, after, saved, hadZero:!!zero, zeroAmount:zero?zero.amount:undefined, amtField, restored};
  })()`);
  assert.ok(watchZero.saved, "0 股買入應可儲存（觀察用），不應被擋");
  assert.ok(watchZero.hadZero, "應存在一筆 0 股買入");
  assert.equal(watchZero.zeroAmount, null, "0 股買入的成交金額應為 null（成本 0）");
  assert.equal(watchZero.amtField, "", "0 股時成交金額欄應為空");
  assert.equal(watchZero.after, watchZero.before, "新增 0 股不應改變既有持股數");
  assert.equal(watchZero.restored, watchZero.before, "刪除 0 股觀察後持股應還原");
  console.log("[e2e] zero-share watch holding passed:", JSON.stringify(watchZero));

  await cdp.evaluate(`document.querySelector("#dlgMng").close()`);
  console.log("[e2e] stock management passed");

  // 買賣標記：圖上標 B/S、點 S 看明細；賣出以平均成本法扣減持股、計入已實現損益
  await cdp.evaluate(`[...document.querySelectorAll("#tbody tr[data-id]")].find(tr=>tr.textContent.includes("2330.TW")).click()`);
  await waitForPage(cdp, `chartView==="fund" && chart?.data?.datasets?.length===1 && (chart.options.plugins?.markers?.meta?.labels||[]).length>20`, 30000);
  const markerTest = await cdp.evaluate(`(async()=>{
    const labels = chart.options.plugins.markers.meta.labels;
    const buyLabel = labels[Math.floor(labels.length*0.2)];
    const sellLabel = labels[Math.floor(labels.length*0.8)];
    const h = holdings.find(item=>item.symbol==="2330.TW");
    h.sells = [];                                   // 先量測賣出前持股與均價
    h.purchases[0].date = buyLabel;                 // 對齊既有買入到可見 label
    renderAll(); await new Promise(r=>setTimeout(r,100));
    const unitsBefore = totUnits(h), avgBefore = avgNav(h);
    h.sells = [{sellId:"s_e2e", date:sellLabel, units:5, price:100, fee:0, note:"e2e賣出"}];
    renderAll();
    await new Promise(r=>setTimeout(r,300));
    const markerDates = (chart.$markers||[]).map(m=>m.date);
    const sm = (chart.$markers||[]).find(m=>m.date===sellLabel);
    let detail = null;
    if(sm){
      handleMarkerClick({x:sm.x,y:0}, chart, h.id);
      await new Promise(r=>setTimeout(r,150));
      const dlg=document.querySelector("#dlgTxn");
      detail={open:dlg.open, tags:[...dlg.querySelectorAll(".txn-tag")].map(t=>t.textContent.trim()), hasSell:document.querySelector("#txnDetailBody").textContent.includes("賣出")};
      dlg.close();
    }
    const pos = positionOf(h);
    return {buyLabel, sellLabel, markerDates, unitsBefore, avgBefore, unitsAfter:pos.held, realized:pos.realized, sellsCount:h.sells.length, detail};
  })()`);
  assert.ok(markerTest.markerDates.includes(markerTest.buyLabel), "圖上應有買入(B)標記：" + JSON.stringify(markerTest.markerDates));
  assert.ok(markerTest.markerDates.includes(markerTest.sellLabel), "圖上應有賣出(S)標記");
  assert.equal(markerTest.unitsAfter, markerTest.unitsBefore - 5, "賣出 5 應扣減持股");
  const expectedRealized = 5*100 - 5*markerTest.avgBefore;   // 平均成本法
  assert.ok(Math.abs(markerTest.realized - expectedRealized) < 0.01,
    `已實現損益應為 5×(100−均價 ${markerTest.avgBefore})=${expectedRealized.toFixed(2)}，實際 ${markerTest.realized}`);
  assert.equal(markerTest.sellsCount, 1);
  assert.ok(markerTest.detail && markerTest.detail.open, "點擊 S 標記應開啟交易明細彈窗");
  assert.deepEqual(markerTest.detail.tags, ["S"]);
  assert.ok(markerTest.detail.hasSell, "明細應含賣出資訊");
  console.log("[e2e] buy/sell markers + realized P&L passed:", JSON.stringify({markers:markerTest.markerDates, unitsAfter:markerTest.unitsAfter, realized:markerTest.realized}));

  await cdp.evaluate(`(() => {
    const h=JSON.parse(localStorage.getItem("fund_tracker_holdings")).find(item=>item.symbol==="2330.TW");
    document.querySelector('button[data-act="cmp"][data-id="'+h.id+'"]').click();
  })()`);
  await waitForPage(cdp, `chartView==="compare" && chart?.data?.datasets?.some(dataset=>dataset.label.startsWith("股票 ·"))`, 30000);
  const stockComparison = await cdp.evaluate(`({
    labels:chart.data.datasets.map(dataset=>dataset.label),
    checkedFunds:document.querySelectorAll("#fundPicker input:checked").length,
    checkedMarkets:document.querySelectorAll("#marketPicker input:checked").length,
    panelVisible:!document.querySelector("#comparePanel").hidden
  })`);
  assert.ok(stockComparison.labels.some((label) => label.includes("2330")));
  assert.equal(stockComparison.checkedFunds, 3);
  assert.equal(stockComparison.checkedMarkets, 1);
  assert.equal(stockComparison.panelVisible, true);
  console.log("[e2e] cross-asset comparison passed");

  // 離開比較模式回到單一基金走勢圖（漲跌色測試需主圖為單一資產的趨勢色線）
  await cdp.evaluate(`[...document.querySelectorAll("#tbody tr[data-id]")].find(tr=>tr.textContent.includes("統一奔騰")).click()`);
  await waitForPage(cdp, `chartView==="fund" && document.querySelector("#comparePanel").hidden && chart?.data?.datasets?.length===1`);

  const themeBefore = await cdp.evaluate(`document.body.dataset.theme`);
  await cdp.evaluate(`document.querySelector("#btnTheme").click()`);
  const themeAfter = await cdp.evaluate(`document.body.dataset.theme`);
  assert.notEqual(themeBefore, themeAfter);

  const colorsBeforeSwap = await cdp.evaluate(`({
    up:getComputedStyle(document.body).getPropertyValue("--up").trim(),
    down:getComputedStyle(document.body).getPropertyValue("--down").trim(),
    line:chart.data.datasets[0].borderColor,
    rising:chart.data.datasets[0].data.filter(Number.isFinite).at(-1)>chart.data.datasets[0].data.filter(Number.isFinite)[0]
  })`);
  assert.equal(colorsBeforeSwap.line,colorsBeforeSwap.rising?colorsBeforeSwap.up:colorsBeforeSwap.down);
  await cdp.evaluate(`document.querySelector("#btnColorSwap").click()`);
  const colorsAfterSwap = await cdp.evaluate(`({
    up:getComputedStyle(document.body).getPropertyValue("--up").trim(),
    down:getComputedStyle(document.body).getPropertyValue("--down").trim(),
    line:chart.data.datasets[0].borderColor,
    pressed:document.querySelector("#btnColorSwap").getAttribute("aria-pressed"),
    saved:JSON.parse(localStorage.getItem("fund_tracker_settings")).swapGainLossColors
  })`);
  assert.equal(colorsAfterSwap.up, colorsBeforeSwap.down);
  assert.equal(colorsAfterSwap.down, colorsBeforeSwap.up);
  assert.equal(colorsAfterSwap.line,colorsBeforeSwap.rising?colorsAfterSwap.up:colorsAfterSwap.down);
  assert.equal(colorsAfterSwap.pressed, "true");
  assert.equal(colorsAfterSwap.saved, true);

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await cdp.send("Page.reload", { ignoreCache: true });
  await waitForPage(cdp, `document.querySelectorAll("#tbody tr").length===3`);
  // 先在「單一資產」檢視量測主圖版面（比較面板會佔用主圖區，故主圖版面在非比較模式量測）
  await waitForPage(cdp, `chartView!=="compare" && chart?.data?.datasets?.length>=1 && document.querySelector("#chartHint").style.display==="none"`, 30000);
  const mobile = await cdp.evaluate(`({
    viewport:innerWidth,
    viewportHeight:innerHeight,
    bodyWidth:document.body.scrollWidth,
    actionDockPosition:getComputedStyle(document.querySelector("#actionDock")).position,
    actionButtonHeight:Math.round(document.querySelector("#btnRefresh").getBoundingClientRect().height),
    marketToolsDisplay:getComputedStyle(document.querySelector("#marketBarTools")).display,
    combinedUpdateStatus:document.querySelector("#updStatus").textContent,
    summaryColumns:getComputedStyle(document.querySelector(".summary")).gridTemplateColumns.split(" ").length,
    summaryVisibleItems:[...document.querySelectorAll(".sum-item")].filter(item=>{
      const rect=item.getBoundingClientRect();
      return rect.width>0 && rect.top>=0 && rect.bottom<=innerHeight;
    }).length,
    assetHeadingLeft:getComputedStyle(document.querySelector("#fundTable th:first-child")).left,
    assetCellPosition:getComputedStyle(document.querySelector("#tbody tr:first-child td:first-child")).position,
    assetCellLeft:getComputedStyle(document.querySelector("#tbody tr:first-child td:first-child")).left,
    operationColumnDisplay:getComputedStyle(document.querySelector("#fundTable th:last-child")).display,
    operationCellButtons:document.querySelectorAll("#tbody tr:first-child td:last-child button[data-act]").length,
    operationCellIndex:[...document.querySelector("#tbody tr:first-child").children].findIndex(cell=>cell.classList.contains("operation-cell")),
    operationCellText:document.querySelector("#tbody tr:first-child td:last-child").textContent,
    nameCellButtons:document.querySelectorAll("#tbody tr:first-child td:first-child button[data-act]").length,
    mainChartAreaHeight:Math.round(document.querySelector("#chartArea").getBoundingClientRect().height),
    mainChartWrapHeight:Math.round(document.querySelector("#chartWrap").getBoundingClientRect().height),
    mainChartCanvasHeight:document.querySelector("#chartCanvas").height,
    mainChartVisible:document.querySelector("#chartHint").style.display==="none",
    chartViewportIntersection:Math.max(0,Math.min(document.querySelector("#chartCanvas").getBoundingClientRect().bottom,document.querySelector("#actionDock").getBoundingClientRect().top)-Math.max(0,document.querySelector("#chartCanvas").getBoundingClientRect().top)),
    pageScrollHeight:document.documentElement.scrollHeight,
    chartBottomSpace:Math.round(chart.height-chart.chartArea.bottom),
    chartXAxisPadding:chart.options.scales.x.ticks.padding,
    chartXAxisMaxRotation:chart.options.scales.x.ticks.maxRotation,
    mainChartFontSize:chart.options.scales.x.ticks.font.size
  })`);
  assert.equal(mobile.viewport, 390);
  assert.equal(mobile.bodyWidth, 390);
  assert.equal(mobile.actionDockPosition, "fixed");
  assert.ok(mobile.actionButtonHeight >= 50);
  assert.equal(mobile.marketToolsDisplay,"none");
  assert.match(mobile.combinedUpdateStatus,/基金淨值/);
  assert.match(mobile.combinedUpdateStatus,/股市 (Yahoo|TWSE|Cloudflare|市場 API)/);
  assert.equal(mobile.summaryColumns,3);
  assert.equal(mobile.summaryVisibleItems,6);
  assert.equal(mobile.assetHeadingLeft,"auto");
  assert.notEqual(mobile.assetCellPosition,"sticky");
  assert.equal(mobile.assetCellLeft,"auto");
  assert.notEqual(mobile.operationColumnDisplay, "none");
  assert.equal(mobile.operationCellButtons,4);
  assert.equal(mobile.operationCellIndex,10);
  assert.match(mobile.operationCellText.replace(/\s+/g,""),/買入.*管理.*比較/);
  assert.equal(mobile.nameCellButtons,0);
  assert.ok(mobile.mainChartAreaHeight >= 590);
  assert.ok(mobile.mainChartWrapHeight >= 450);
  assert.ok(mobile.mainChartCanvasHeight > 400);
  assert.equal(mobile.mainChartVisible,true);
  assert.ok(mobile.pageScrollHeight > mobile.viewportHeight);
  assert.ok(mobile.chartBottomSpace >= 50);
  assert.ok(mobile.chartXAxisPadding >= 10);
  assert.ok(mobile.chartXAxisMaxRotation <= 30);
  assert.ok(mobile.mainChartFontSize >= 13);

  // 手機版比較檢視：開啟後重疊折線畫在主畫布、內嵌面板顯示、字級足夠大
  await cdp.evaluate(`document.querySelector("#btnCompareView").click()`);
  await waitForPage(cdp, `chartView==="compare" && chart?.data?.datasets?.length>=3`, 30000);
  const compareMobile = await cdp.evaluate(`({
    panelVisible:!document.querySelector("#comparePanel").hidden,
    canvasWidth:document.querySelector("#chartCanvas").width,
    canvasHeight:document.querySelector("#chartCanvas").height,
    fontSize:chart.options.scales.x.ticks.font.size,
    datasets:chart.data.datasets.length
  })`);
  assert.equal(compareMobile.panelVisible, true);
  assert.ok(compareMobile.canvasWidth > 300);
  assert.ok(compareMobile.canvasHeight > 200);
  assert.ok(compareMobile.fontSize >= 13);
  assert.ok(compareMobile.datasets >= 3);
  const persistedColorSwap = await cdp.evaluate(`({
    setting:JSON.parse(localStorage.getItem("fund_tracker_settings")).swapGainLossColors,
    attribute:document.body.dataset.colorSwap,
    pressed:document.querySelector("#btnColorSwap").getAttribute("aria-pressed")
  })`);
  assert.deepEqual(persistedColorSwap,{setting:true,attribute:"true",pressed:"true"});

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
    refreshResults,
    refreshFeedback,
    latestQuoteReconciliation,
    comparison,
    comparisonBusinessDayPoints,
    fundSearch,
    stockSearch,
    pickedStock,
    stockHolding,
    shortRangePoints,
    stockManagement,
    stockComparison,
    colorsBeforeSwap,
    colorsAfterSwap,
    persistedColorSwap,
    mobile,
    compareMobile,
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
    await sleep(500);
    await removeProfileDirectory(profileDir);
  }
}
