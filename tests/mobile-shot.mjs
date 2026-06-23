// 手機版截圖工具：headless Chrome @ 390x844，截全頁 PNG 供版面檢視/驗證
// 用法：node tests/mobile-shot.mjs [scene]
//   scene: main(預設) | incep | manage | compare | alloc | contrib | timeline | addstock
// 輸出：tests/_mobile-<scene>.png
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const port = 8766;
const cdpPort = 9226;
const site = `http://127.0.0.1:${port}/index.html`;
const scene = (process.argv[2] || "main").toLowerCase();
const outFile = join(repoRoot, "tests", `_mobile-${scene}.png`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startServer() {
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png" };
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, site).pathname);
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const resolved = normalize(join(repoRoot, rel));
      if (!resolved.startsWith(repoRoot)) { res.writeHead(403).end(); return; }
      const body = await readFile(resolved);
      res.writeHead(200, { "Content-Type": types[extname(resolved)] || "application/octet-stream", "Cache-Control": "no-store" });
      res.end(body);
    } catch { res.writeHead(404).end("Not found"); }
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async connect() {
    await new Promise((res, rej) => { this.ws.addEventListener("open", res, { once: true }); this.ws.addEventListener("error", rej, { once: true }); });
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); }
    });
  }
  send(method, params = {}) { const id = ++this.id; const pr = new Promise((res, rej) => this.pending.set(id, { res, rej })); this.ws.send(JSON.stringify({ id, method, params })); return pr; }
  async evaluate(expression) { const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; }
}

// 8 年週線歷史，足以重現「成立至今」的長跨距日期軸
function seed() {
  return `(() => {
    const mkW=(b,g)=>{const a=[];const e=new Date('2026-06-12');const N=416;for(let i=0;i<N;i++){const d=new Date(e.getTime()-(N-1-i)*7*864e5);a.push({date:d.toISOString().slice(0,10),nav:+(b*(1+i*g)+Math.sin(i/8)*b*0.03).toFixed(2)});}return a;};
    localStorage.clear();
    localStorage.setItem("fund_tracker_holdings", JSON.stringify([
      {id:"a",assetType:"stock",fundCode:"2330.TW",symbol:"2330.TW",fundName:"台積電",currency:"TWD",isin:"",purchases:[{purchaseId:"p1",type:"LUMP",date:"2020-03-02",units:10,navAtPurchase:300,amount:3000,fee:20,note:"開倉"}],dividends:[{divId:"d1",date:"2025-05-10",amount:300,note:"現金股利"}],rspPlans:[{planId:"r1",dayOfMonth:5,amount:3000,fee:0,startDate:"2024-01-05",enabled:true}],sells:[{sellId:"s1",date:"2025-05-20",units:4,price:900,fee:10,note:"部分了結"}]},
      {id:"b",assetType:"fund",fundCode:"F0X",symbol:"",fundName:"統一奔騰基金",currency:"TWD",isin:"",purchases:[{purchaseId:"p2",type:"RSP",date:"2022-04-01",units:50,navAtPurchase:18,amount:900,fee:0,note:""}],dividends:[],rspPlans:[],sells:[]},
      {id:"c",assetType:"stock",fundCode:"AAPL",symbol:"AAPL",fundName:"蘋果",currency:"USD",isin:"",purchases:[{purchaseId:"p3",type:"LUMP",date:"2021-02-01",units:5,navAtPurchase:130,amount:650,fee:0,note:""}],dividends:[],rspPlans:[],sells:[]}
    ]));
    localStorage.setItem("fund_tracker_nav_cache_2330.TW", JSON.stringify({fundCode:"2330.TW",navHistory:mkW(300,0.004),source:"t"}));
    localStorage.setItem("fund_tracker_nav_cache_F0X", JSON.stringify({fundCode:"F0X",navHistory:mkW(18,0.002),source:"t"}));
    localStorage.setItem("fund_tracker_nav_cache_AAPL", JSON.stringify({fundCode:"AAPL",navHistory:mkW(130,0.003),source:"t"}));
    localStorage.setItem("fund_tracker_settings", JSON.stringify({refreshOnOpen:false,theme:"dark",marketSymbols:[]}));
  })()`;
}

const sceneActions = {
  main: `document.querySelector('#tbody tr[data-id]')?.click();`,
  incep: `document.querySelector('#tbody tr[data-id]')?.click(); await new Promise(r=>setTimeout(r,500)); curRange="成立至今"; renderTabs(); renderChart();`,
  manage: `openMng('a');`,
  compare: `(typeof enterCompareView==='function')?enterCompareView():document.querySelector('button[data-act="cmp"]')?.click();`,
  alloc: `document.querySelector('#tbody tr[data-id]')?.click(); openAlloc();`,
  contrib: `openContrib();`,
  timeline: `openTimeline();`,
  addstock: `document.querySelector('#btnAddStock')?.click();`,
};

async function main() {
  const server = await startServer();
  const profileDir = await mkdtemp(join(tmpdir(), "fund-mobile-shot-"));
  const chrome = spawn(chromePath, ["--headless=new", "--disable-gpu", "--disable-extensions", "--no-first-run", `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profileDir}`, "--window-size=400,900", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let cdp;
  try {
    let target = null;
    for (let i = 0; i < 60 && !target; i++) {
      try { const r = await fetch(`http://127.0.0.1:${cdpPort}/json/list`); const list = await r.json(); target = list.find((t) => t.type === "page"); } catch {}
      if (!target) await sleep(250);
    }
    if (!target) throw new Error("Chrome page target not found");
    cdp = new Cdp(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Page.navigate", { url: site });
    await sleep(2000);
    await cdp.evaluate(seed());
    await cdp.send("Page.reload", { ignoreCache: true });
    await sleep(2500);
    const action = sceneActions[scene] || sceneActions.main;
    await cdp.evaluate(`(async()=>{ ${action} })()`);
    await sleep(1800);
    const dims = await cdp.evaluate(`({w:innerWidth,h:innerHeight,scroll:document.documentElement.scrollHeight})`);
    const shot = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(outFile, Buffer.from(shot.data, "base64"));
    console.log(JSON.stringify({ ok: true, scene, outFile, viewport: dims }));
  } finally {
    if (chrome?.pid) spawnSync("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    server.close();
    await rm(profileDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
