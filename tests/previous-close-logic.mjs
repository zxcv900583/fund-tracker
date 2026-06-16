import assert from "node:assert/strict";
import {
  indexTimeZone,
  marketDateFromUnix,
  normalizeQuote,
  normalizeTwseRealtimeQuote,
  previousCloseFromAlignedDailyKLine,
} from "../worker/worker.js";

function unixUtc(year, monthIndex, day, hour = 0, minute = 0, second = 0) {
  return Math.floor(Date.UTC(year, monthIndex, day, hour, minute, second) / 1000);
}

function yahooPayload({
  symbol,
  price,
  previousClose,
  marketTime,
  points,
  currency = "USD",
  exchange = "YHD",
}) {
  return {
    chart: {
      result: [{
        meta: {
          symbol,
          currency,
          exchangeName: exchange,
          regularMarketPrice: price,
          regularMarketTime: marketTime,
          previousClose,
          currentTradingPeriod: {
            regular: {
              start: marketTime - 60,
              end: marketTime + 60,
            },
          },
        },
        timestamp: points.map((point) => point.timestamp),
        indicators: {
          quote: [{
            close: points.map((point) => point.close),
          }],
        },
      }],
      error: null,
    },
  };
}

function pctChange(price, previousClose) {
  return (price - previousClose) / previousClose * 100;
}

{
  const quoteMarketTime = 1781501605; // 2026-06-15 in Asia/Taipei.
  const payload = yahooPayload({
    symbol: "^TWII",
    currency: "TWD",
    exchange: "TAI",
    price: 45396.99,
    previousClose: 43149.4609375,
    marketTime: quoteMarketTime,
    points: [
      { timestamp: unixUtc(2026, 5, 12, 1), close: 44506.85 },
      { timestamp: unixUtc(2026, 5, 15, 1), close: 45396.99 },
    ],
  });

  const corrected = normalizeQuote("^TWII", payload);

  assert.equal(previousCloseFromAlignedDailyKLine("^TWII", payload, quoteMarketTime), 44506.85);
  assert.equal(corrected.previousClose, 44506.85);
  assert.equal(corrected.previousCloseOriginal, 43149.4609375);
  assert.equal(corrected.previousCloseSource, "daily-kline-aligned");
  assert.equal(corrected.previousCloseMarketDate, "2026-06-15");

  const pct = pctChange(corrected.price, corrected.previousClose);
  assert.ok(pct > 1.5 && pct < 3, `^TWII pct should be near the intended trading-day move, got ${pct}`);
}

{
  const payload = yahooPayload({
    symbol: "^TWII",
    currency: "TWD",
    exchange: "TAI",
    price: 45396.99,
    previousClose: 43149.4609375,
    marketTime: unixUtc(2026, 5, 16, 1),
    points: [
      { timestamp: unixUtc(2026, 5, 12, 1), close: 44506.85 },
      { timestamp: unixUtc(2026, 5, 15, 1), close: 45396.99 },
    ],
  });

  const unchanged = normalizeQuote("^TWII", payload);

  assert.equal(previousCloseFromAlignedDailyKLine("^TWII", payload, unixUtc(2026, 5, 16, 1)), null);
  assert.equal(unchanged.previousClose, 43149.4609375);
  assert.equal(unchanged.previousCloseSource, "yahoo-meta");
  assert.equal(unchanged.previousCloseOriginal, undefined);
}

{
  const payload = yahooPayload({
    symbol: "^TWII",
    currency: "TWD",
    exchange: "TAI",
    price: 45586.34,
    previousClose: undefined,
    marketTime: 1781580405,
    points: [
      { timestamp: unixUtc(2026, 5, 10, 1), close: 43225.54 },
      { timestamp: unixUtc(2026, 5, 11, 1), close: 43149.46 },
      { timestamp: unixUtc(2026, 5, 12, 1), close: 44169.04 },
      { timestamp: unixUtc(2026, 5, 15, 1), close: null },
      { timestamp: unixUtc(2026, 5, 16, 1), close: 45586.34 },
    ],
  });

  const guarded = normalizeQuote("^TWII", payload);

  assert.equal(previousCloseFromAlignedDailyKLine("^TWII", payload, 1781580405), null);
  assert.equal(guarded.previousClose, null);
  assert.equal(guarded.previousCloseSource, "daily-kline");
}

{
  const twseQuote = normalizeTwseRealtimeQuote({
    msgArray: [{
      ch: "t00.tw",
      d: "20260616",
      t: "11:46:50",
      z: "45690.82",
      y: "45396.99",
      o: "45500.08",
      h: "45737.69",
      l: "45266.34",
    }],
  });

  assert.equal(twseQuote.symbol, "^TWII");
  assert.equal(twseQuote.price, 45690.82);
  assert.equal(twseQuote.previousClose, 45396.99);
  assert.equal(twseQuote.previousCloseSource, "twse-realtime");
  assert.equal(twseQuote.open, 45500.08);
  assert.equal(twseQuote.dayHigh, 45737.69);
  assert.equal(twseQuote.dayLow, 45266.34);
  assert.equal(marketDateFromUnix(twseQuote.marketTime, "Asia/Taipei"), "2026-06-16");
  assert.deepEqual(twseQuote.session, {
    start: unixUtc(2026, 5, 16, 1),
    end: unixUtc(2026, 5, 16, 5, 30),
  });

  const pct = pctChange(twseQuote.price, twseQuote.previousClose);
  assert.ok(pct > 0.6 && pct < 0.7, `TWSE realtime pct should be about +0.64%, got ${pct}`);
}

{
  const quoteMarketTime = unixUtc(2026, 5, 16, 1, 30); // 2026-06-15 in New York, 2026-06-16 in Taipei.
  const payload = yahooPayload({
    symbol: "^GSPC",
    price: 7100,
    previousClose: 6500,
    marketTime: quoteMarketTime,
    points: [
      { timestamp: unixUtc(2026, 5, 12, 13, 30), close: 7000 },
      { timestamp: unixUtc(2026, 5, 15, 13, 30), close: 7100 },
    ],
  });

  const corrected = normalizeQuote("^GSPC", payload);

  assert.equal(indexTimeZone("^GSPC"), "America/New_York");
  assert.equal(marketDateFromUnix(quoteMarketTime, "America/New_York"), "2026-06-15");
  assert.equal(marketDateFromUnix(quoteMarketTime, "Asia/Taipei"), "2026-06-16");
  assert.equal(corrected.previousClose, 7000);
  assert.equal(corrected.previousCloseSource, "daily-kline-aligned");
}

{
  assert.equal(indexTimeZone("^TWII"), "Asia/Taipei");
  assert.equal(indexTimeZone("^IXIC"), "America/New_York");
  assert.equal(indexTimeZone("^DJI"), "America/New_York");
  assert.equal(indexTimeZone("^N225"), "Asia/Tokyo");
  assert.equal(indexTimeZone("^HSI"), "Asia/Hong_Kong");
}

for (const symbol of ["AAPL", "2330.TW", "0050.TW", "SPY"]) {
  const quoteMarketTime = unixUtc(2026, 5, 16, 1, 30);
  const payload = yahooPayload({
    symbol,
    price: 200,
    previousClose: 190,
    marketTime: quoteMarketTime,
    points: [
      { timestamp: unixUtc(2026, 5, 12, 13, 30), close: 180 },
      { timestamp: unixUtc(2026, 5, 15, 13, 30), close: 200 },
    ],
  });

  const unchanged = normalizeQuote(symbol, payload);

  assert.equal(indexTimeZone(symbol), null);
  assert.equal(previousCloseFromAlignedDailyKLine(symbol, payload, quoteMarketTime), null);
  assert.equal(unchanged.previousClose, 190);
  assert.equal(unchanged.previousCloseSource, "yahoo-meta");
}

console.log(JSON.stringify({
  ok: true,
  coveredSymbols: ["^TWII", "^GSPC", "^IXIC", "^DJI", "^N225", "^HSI", "AAPL", "2330.TW", "0050.TW", "SPY"],
}, null, 2));
