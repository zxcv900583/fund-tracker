// 純函式單元測試：直接從 index.html 抽出金融計算與消毒函式在 Node 執行，
// 不需瀏覽器、不需網路、零依賴。單檔架構下的折衷：以宣告名稱＋大括號配對
// 抽取頂層函式原始碼（風格約定：計算函式皆為頂層宣告、無多行樣板字串）。
// 執行：node tests/unit-calc.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

// 從 startIndex 起找到第一個 { 並配對到對應 }，略過字串與註解（regex 內大括號必然成對，可安全計數）
function sliceBalanced(source, startIndex) {
  const openIdx = source.indexOf("{", startIndex);
  let depth = 0, inStr = null, inLine = false, inBlock = false;
  for (let i = openIdx; i < source.length; i++) {
    const ch = source[i];
    if (inLine) { if (ch === "\n") inLine = false; continue; }
    if (inBlock) { if (ch === "/" && source[i - 1] === "*") inBlock = false; continue; }
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") { inStr = ch; continue; }
    if (ch === "/" && source[i + 1] === "/") { inLine = true; continue; }
    if (ch === "/" && source[i + 1] === "*") { inBlock = true; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return source.slice(startIndex, i + 1); }
  }
  throw new Error("unbalanced braces");
}

function extractFunction(name) {
  const match = new RegExp(`\\nfunction ${name}\\(`).exec(html);
  if (!match) throw new Error(`function ${name} not found in index.html`);
  const code = sliceBalanced(html, match.index + 1);
  assert.ok(code.endsWith("}"), `${name} extraction ended unexpectedly`);
  return code;
}

function extractConst(name) {
  const match = new RegExp(`\\nconst ${name} = `).exec(html);
  if (!match) throw new Error(`const ${name} not found in index.html`);
  const start = match.index + 1;
  const lineEnd = html.indexOf("\n", start);
  let line = html.slice(start, lineEnd).trim();
  const semi = line.lastIndexOf(";");
  assert.ok(semi > 0, `${name} must be a single-line const`);
  line = line.slice(0, semi + 1);   // 去掉行尾註解
  return line;
}

const source = [
  extractConst("MAX_HIST"),
  extractConst("uid"),
  extractConst("addDays"),
  extractConst("purCost"),
  extractConst("IMP_DATE_RE"),
  extractConst("impStr"),
  extractConst("impPosNum"),
  extractConst("csvNum"),
  extractConst("isIsin"),
  extractFunction("xirr"),
  extractFunction("positionOf"),
  extractFunction("unitsOnDate"),
  extractFunction("detectStockDividends"),
  extractFunction("schedDateFor"),
  extractFunction("nextSched"),
  extractFunction("findNavInList"),
  extractFunction("navOnOrBefore"),
  extractFunction("cleanPrice"),
  extractFunction("cleanAmount"),
  extractFunction("csvNormType"),
  extractFunction("csvNormDate"),
  extractFunction("parseCsv"),
  extractFunction("sanitizeImportedHoldings"),
  extractFunction("sanitizeImportedNavCache"),
].join("\n");

const lib = new Function(`"use strict";\n${source}\nreturn {xirr, positionOf, unitsOnDate, detectStockDividends, schedDateFor, nextSched, findNavInList, navOnOrBefore, cleanPrice, cleanAmount, csvNormType, csvNormDate, parseCsv, sanitizeImportedHoldings, sanitizeImportedNavCache, purCost, addDays};`)();

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
}

/* ---------------- xirr ---------------- */
check("xirr 單筆一年 +10%", () => {
  const r = lib.xirr([{ date: "2024-01-01", amt: -1000 }, { date: "2025-01-01", amt: 1100 }]);
  assert.ok(Math.abs(r - 0.09978) < 0.001, `expected ~0.0998, got ${r}`);
});
check("xirr 定期定額為正", () => {
  const flows = [];
  for (let m = 1; m <= 12; m++) flows.push({ date: `2024-${String(m).padStart(2, "0")}-05`, amt: -100 });
  flows.push({ date: "2025-01-05", amt: 1300 });
  const r = lib.xirr(flows);
  assert.ok(r > 0.1 && r < 0.4, `expected positive annualized, got ${r}`);
});
check("xirr 期間過短回 null", () => {
  assert.equal(lib.xirr([{ date: "2026-01-01", amt: -100 }, { date: "2026-01-04", amt: 105 }]), null);
});
check("xirr 無正負對沖回 null", () => {
  assert.equal(lib.xirr([{ date: "2024-01-01", amt: -100 }, { date: "2025-01-01", amt: -105 }]), null);
  assert.equal(lib.xirr([]), null);
  assert.equal(lib.xirr(null), null);
});

/* ---------------- purCost / positionOf（平均成本法） ---------------- */
check("purCost 金額優先、含手續費", () => {
  assert.equal(lib.purCost({ amount: 1000, fee: 15, units: 999, navAtPurchase: 999 }), 1015);
  assert.equal(lib.purCost({ units: 10, navAtPurchase: 25, fee: 5 }), 255);
});
check("positionOf 平均成本與已實現", () => {
  const p = lib.positionOf({
    purchases: [{ date: "2026-01-05", units: 100, amount: 1000, fee: 0 }],
    sells: [{ date: "2026-02-05", units: 50, price: 12, fee: 10 }],
  });
  assert.equal(p.held, 50);
  assert.equal(p.basis, 500);
  assert.equal(p.realized, 90);          // (50×12−10) − 500
  assert.equal(p.proceeds, 590);
  assert.equal(p.grossInvested, 1000);
  assert.equal(p.avgCost, 10);
});
check("positionOf 賣超只計持有部分", () => {
  const p = lib.positionOf({
    purchases: [{ date: "2026-01-05", units: 10, amount: 100 }],
    sells: [{ date: "2026-02-05", units: 20, price: 15, fee: 0 }],
  });
  assert.equal(p.held, 0);
  assert.equal(p.sold, 10);
  assert.equal(p.realized, 50);          // 10×15 − 100，超出的 10 股不計
});
check("positionOf 同日先買後賣、事件亂序輸入", () => {
  const p = lib.positionOf({
    purchases: [{ date: "2026-03-01", units: 10, amount: 100 }],
    sells: [{ date: "2026-03-01", units: 10, price: 20, fee: 0 }],
  });
  assert.equal(p.realized, 100);
  const q = lib.positionOf({
    purchases: [
      { date: "2026-02-01", units: 5, amount: 100 },
      { date: "2026-01-01", units: 5, amount: 50 },
    ],
    sells: [{ date: "2026-01-15", units: 5, price: 30, fee: 0 }],  // 只能賣 1/1 買的 5 股
  });
  assert.equal(q.realized, 100);         // 5×30 − 50
  assert.equal(q.held, 5);
  assert.equal(q.basis, 100);
});
check("positionOf 空持倉", () => {
  const p = lib.positionOf({ purchases: [], sells: [] });
  assert.equal(p.held, 0);
  assert.equal(p.avgCost, null);
  assert.equal(p.grossInvested, 0);
});

/* ---------------- 股票除息偵測（v1.30） ---------------- */
check("unitsOnDate 除息日前持股回放", () => {
  const h = {
    purchases: [{ date: "2026-01-05", units: 100 }, { date: "2026-03-10", units: 50 }],
    sells: [{ date: "2026-02-01", units: 30 }],
  };
  assert.equal(lib.unitsOnDate(h, "2026-01-05"), 0);      // 除息日當天買進不算
  assert.equal(lib.unitsOnDate(h, "2026-01-06"), 100);
  assert.equal(lib.unitsOnDate(h, "2026-02-02"), 70);
  assert.equal(lib.unitsOnDate(h, "2026-03-11"), 120);
  assert.equal(lib.unitsOnDate({ purchases: [{ date: "2026-01-05", units: 5 }], sells: [{ date: "2026-01-06", units: 99 }] }, "2026-01-07"), 0);  // 賣超夾擠
});
check("detectStockDividends 狀態分類與稅估", () => {
  const h = {
    assetType: "stock", currency: "USD",
    purchases: [{ date: "2025-01-01", units: 10 }], sells: [],
    dividends: [{ date: "2025-07-01", amount: 5 }],
    divDismissed: ["2025-10-01|0.5"],
  };
  const out = lib.detectStockDividends(h, [
    { date: "2025-07-01", perShare: 0.5 },     // 同日已有記錄 → dup
    { date: "2025-10-01", perShare: 0.5 },     // 已略過 → dismissed
    { date: "2026-01-05", perShare: 0.6 },     // → new，美股估 70%
    { date: "2024-12-01", perShare: 0.4 },     // 除息時 0 股 → 不出現
    { date: "bad-date", perShare: 1 },
  ]);
  assert.deepEqual(out.map(x => x.status), ["new", "dismissed", "dup"]);   // 日期新→舊排序
  const fresh = out[0];
  assert.equal(fresh.gross, 6);
  assert.equal(fresh.amount, 4.2);              // 10×0.6×0.7 預扣稅估算
  assert.equal(fresh.us, true);
  assert.equal(fresh.key, "2026-01-05|0.6");
  // 台幣不估稅、非股票回空
  const tw = lib.detectStockDividends({ ...h, currency: "TWD", dividends: [], divDismissed: [] }, [{ date: "2026-01-05", perShare: 0.6 }]);
  assert.equal(tw[0].amount, 6);
  assert.deepEqual(lib.detectStockDividends({ ...h, assetType: "fund" }, [{ date: "2026-01-05", perShare: 1 }]), []);
});
check("sanitize 保留合法 divDismissed", () => {
  const [h] = lib.sanitizeImportedHoldings([{
    fundCode: "S1", assetType: "stock", fundName: "x", currency: "TWD",
    divDismissed: ["2026-01-05|0.6", "evil{}", "2026-01-06|abc", 123],
  }]);
  assert.deepEqual(h.divDismissed, ["2026-01-05|0.6"]);
});

/* ---------------- 定期定額排程 ---------------- */
check("schedDateFor 月底夾擠（含閏年）", () => {
  assert.equal(lib.schedDateFor(2026, 1, 31), "2026-02-28");
  assert.equal(lib.schedDateFor(2028, 1, 31), "2028-02-29");
  assert.equal(lib.schedDateFor(2026, 3, 31), "2026-04-30");
});
check("nextSched 首期與逐月推進", () => {
  const plan = { startDate: "2026-01-10", dayOfMonth: 6 };
  assert.equal(lib.nextSched(plan, null), "2026-02-06");        // 當月 6 日早於開始日 → 次月
  assert.equal(lib.nextSched({ startDate: "2026-01-06", dayOfMonth: 6 }, null), "2026-01-06");
  assert.equal(lib.nextSched(plan, "2026-02-06"), "2026-03-06");
  assert.equal(lib.nextSched({ startDate: "2026-01-01", dayOfMonth: 31 }, "2026-01-31"), "2026-02-28");
});

/* ---------------- 日期與淨值查找 ---------------- */
check("addDays 跨月與月底", () => {
  assert.equal(lib.addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(lib.addDays("2026-12-31", 1), "2027-01-01");
});
const navList = [
  { date: "2026-01-05", nav: 1 },
  { date: "2026-01-08", nav: 2 },
  { date: "2026-02-20", nav: 3 },
];
check("findNavInList 順延上限", () => {
  assert.equal(lib.findNavInList(navList, "2026-01-06").nav, 2);
  assert.equal(lib.findNavInList(navList, "2026-01-09", 7), null);   // 一週內無資料
});
check("navOnOrBefore 取當日或之前，查無退為之後", () => {
  assert.equal(lib.navOnOrBefore(navList, "2026-01-07").nav, 1);
  assert.equal(lib.navOnOrBefore(navList, "2026-01-08").nav, 2);
  assert.equal(lib.navOnOrBefore(navList, "2026-01-04").nav, 1);     // 之前無 → 之後最近
  assert.equal(lib.navOnOrBefore([], "2026-01-04"), null);
});

/* ---------------- 浮點雜訊清理 ---------------- */
check("cleanPrice / cleanAmount", () => {
  assert.equal(lib.cleanPrice(1873.8707275390625), 1873.87);
  assert.equal(lib.cleanPrice(99.123456), 99.1235);
  assert.equal(lib.cleanPrice(0), "");
  assert.equal(lib.cleanPrice(-5), "");
  assert.equal(lib.cleanAmount(1234.567891), 1234.5679);
});

/* ---------------- CSV 解析 ---------------- */
check("parseCsv 引號、跳脫、CRLF、空列", () => {
  const rows = lib.parseCsv('a,"b,1","c""x"\r\n\r\n1,2,3\n');
  assert.deepEqual(rows, [["a", "b,1", 'c"x'], ["1", "2", "3"]]);
});
check("csvNormType 中英文對應", () => {
  assert.equal(lib.csvNormType("定期定額"), "RSP");
  assert.equal(lib.csvNormType("單筆"), "LUMP");
  assert.equal(lib.csvNormType("dividend"), "DIV");
  assert.equal(lib.csvNormType("轉換"), null);
});
check("csvNormDate 分隔符與範圍", () => {
  assert.equal(lib.csvNormDate("2026/1/6"), "2026-01-06");
  assert.equal(lib.csvNormDate("2026.01.06"), "2026-01-06");
  assert.equal(lib.csvNormDate("2026-13-01"), null);
  assert.equal(lib.csvNormDate("2026-01-32"), null);
  assert.equal(lib.csvNormDate("民國115年"), null);
});

/* ---------------- 匯入消毒（含 v1.25 迴歸） ---------------- */
check("sanitize 保留 0 股觀察記錄（v1.25 迴歸）", () => {
  const [h] = lib.sanitizeImportedHoldings([{
    fundCode: "F0TEST", assetType: "fund", fundName: "測試", currency: "TWD",
    purchases: [
      { date: "2026-01-05", units: 0, navAtPurchase: 0, type: "LUMP", note: "觀察" },
      { date: "2026-01-06", units: 2, navAtPurchase: 10, type: "RSP" },
      { date: "2026-01-07", units: "", navAtPurchase: 10 },      // 空字串 → 剔除
      { date: "2026-01-08", units: -1, navAtPurchase: 10 },      // 負數 → 剔除
      { date: "2026-01-09", units: 3, navAtPurchase: 0 },        // 有單位無淨值 → 剔除
      { date: "2026/01/10", units: 1, navAtPurchase: 5 },        // 日期格式錯 → 剔除
    ],
  }]);
  assert.equal(h.purchases.length, 2);
  assert.ok(h.purchases.some(p => p.units === 0 && p.note === "觀察"));
});
check("sanitize 白名單與 ID 重生成", () => {
  const [h] = lib.sanitizeImportedHoldings([{
    id: "evil", fundCode: "F1", fundName: "x", assetType: "fund",
    currency: "nt$", isin: "not-an-isin",
    purchases: [{ purchaseId: "evil-p", date: "2026-01-05", units: 1, navAtPurchase: 5, type: "HACK", origin: "elsewhere" }],
    dividends: [
      { date: "2026-01-05", amount: 10, origin: "fundrich" },
      { date: "2026-01-06", amount: -3 },                        // 非正數 → 剔除
    ],
    rspPlans: [
      { dayOfMonth: 31, amount: 3000, startDate: "2026-01-31", lastApplied: "bad" },
      { dayOfMonth: 0, amount: 3000, startDate: "2026-01-31" }, // 日期範圍外 → 剔除
    ],
    sells: [
      { date: "2026-02-01", units: 1, price: 6 },
      { date: "2026-02-02", units: 0, price: 6 },                // 賣 0 股 → 剔除
    ],
  }]);
  assert.notEqual(h.id, "evil");
  assert.ok(h.id.startsWith("holding_"));
  assert.equal(h.currency, "TWD");                               // 非 3 碼英文字母 → 預設
  assert.equal(lib.sanitizeImportedHoldings([{ fundCode: "F2", currency: "usd" }])[0].currency, "USD"); // 小寫自動轉大寫
  assert.equal(h.isin, "");
  assert.equal(h.purchases[0].type, "RSP");                      // 非白名單 type → RSP
  assert.notEqual(h.purchases[0].purchaseId, "evil-p");
  assert.equal(h.purchases[0].origin, undefined);                // 只保留 fundrich 標記
  assert.equal(h.dividends.length, 1);
  assert.equal(h.dividends[0].origin, "fundrich");
  assert.equal(h.rspPlans.length, 1);
  assert.equal(h.rspPlans[0].lastApplied, null);
  assert.equal(h.rspPlans[0].enabled, true);
  assert.equal(h.sells.length, 1);
});
check("sanitize 丟棄無 fundCode 與非物件", () => {
  assert.deepEqual(lib.sanitizeImportedHoldings([{ fundName: "沒代碼" }, null, "junk"]), []);
  assert.deepEqual(lib.sanitizeImportedHoldings("not-array"), []);
});
check("sanitizeImportedNavCache 過濾與排序", () => {
  const cache = lib.sanitizeImportedNavCache("F1", {
    lastUpdated: "2026-07-01T00:00:00Z", source: "morningstar",
    navHistory: [
      { date: "2026-01-08", nav: 2 },
      { date: "2026-01-05", nav: 1 },
      { date: "bad", nav: 3 },
      { date: "2026-01-09", nav: -1 },
    ],
  });
  assert.deepEqual(cache.navHistory.map(x => x.date), ["2026-01-05", "2026-01-08"]);
  assert.equal(lib.sanitizeImportedNavCache("F1", null), null);
});

console.log(JSON.stringify({ ok: true, passed }, null, 2));
