// server/funding-bot-vercel-entry.ts
import "dotenv/config";

// server/lib/funding-strategy.ts
var BITFINEX_MIN_FUNDING_OFFER = 150;
var DEFAULT_LADDER = [
  { pct: 80, mult: 1 },
  { pct: 20, mult: 1.15 }
];
function apyToDailyRate(apy) {
  return apy / 100 / 365;
}
function dailyRateToApy(daily) {
  return daily * 365 * 100;
}
function floorTo(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.floor(value * f) / f;
}
function roundTo(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}
function ceilTo(value, decimals) {
  const f = Math.pow(10, decimals);
  return Math.ceil(value * f) / f;
}
function parseLadder(input) {
  const tiers = [];
  for (const part of input.split(",")) {
    const segment = part.trim();
    if (!segment) continue;
    const [rawPct, rawMult] = segment.split(":");
    const pct = Number(rawPct);
    const mult = Number(rawMult);
    if (!Number.isFinite(pct) || !Number.isFinite(mult) || pct <= 0 || mult <= 0) {
      return null;
    }
    tiers.push({ pct, mult });
  }
  return tiers.length > 0 ? tiers : null;
}
function planOffers(deployable, frrDaily, cfg) {
  if (!Number.isFinite(deployable) || !Number.isFinite(frrDaily)) return [];
  if (frrDaily <= 0) return [];
  if (deployable < cfg.minOfferAmount) return [];
  const period = dailyRateToApy(frrDaily) >= cfg.spikeApy ? cfg.spikePeriodDays : cfg.basePeriodDays;
  const floorRate = ceilTo(
    Math.max(apyToDailyRate(cfg.minRateApy), frrDaily * cfg.frrFloorMult),
    8
  );
  let tiers = cfg.tiers.filter((t) => t.pct > 0 && t.mult > 0).slice(0, cfg.maxOffers);
  if (tiers.length === 0) return [];
  while (tiers.length > 1) {
    const weight2 = tiers.reduce((sum, t) => sum + t.pct, 0);
    const amounts = tiers.map((t) => deployable * t.pct / weight2);
    if (Math.min(...amounts) >= cfg.minOfferAmount) break;
    let dropIdx = 0;
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].mult > tiers[dropIdx].mult) dropIdx = i;
    }
    tiers = tiers.filter((_, i) => i !== dropIdx);
  }
  const weight = tiers.reduce((sum, t) => sum + t.pct, 0);
  return tiers.map((t) => ({
    // 無條件捨去到小數 2 位，確保加總不會超過可用餘額
    amount: floorTo(deployable * t.pct / weight, 2),
    rate: Math.max(roundTo(frrDaily * t.mult, 8), floorRate),
    period,
    mult: t.mult
  })).filter((o) => o.amount >= cfg.minOfferAmount);
}
function needsRequote(existing, desired, rateTolerance = 0.05, amountTolerance = 0.1) {
  if (desired.length === 0) return false;
  if (existing.length !== desired.length) return true;
  const e = [...existing].sort((a, b) => a.rate - b.rate);
  const d = [...desired].sort((a, b) => a.rate - b.rate);
  for (let i = 0; i < d.length; i++) {
    if (e[i].period !== d[i].period) return true;
    if (Math.abs(e[i].rate - d[i].rate) / d[i].rate > rateTolerance) return true;
    if (Math.abs(e[i].amount - d[i].amount) / Math.max(d[i].amount, 1) > amountTolerance) {
      return true;
    }
  }
  return false;
}

// server/lib/bitfinex.ts
import crypto from "crypto";
var lastNonce = 0;
function nextNonce() {
  let nonce = Date.now() * 1e3;
  if (nonce <= lastNonce) {
    nonce = lastNonce + 1;
  }
  lastNonce = nonce;
  return nonce.toString();
}
async function bitfinexAuthRequest(apiKey, apiSecret, apiPath, body = {}, retries = 3) {
  const bodyStr = JSON.stringify(body);
  let lastError = "Max retries exceeded";
  for (let attempt = 1; attempt <= retries; attempt++) {
    const nonce = nextNonce();
    const signature = crypto.createHmac("sha384", apiSecret).update(`/api/${apiPath}${nonce}${bodyStr}`).digest("hex");
    try {
      const res = await fetch(`https://api.bitfinex.com/${apiPath}`, {
        method: "POST",
        headers: {
          "bfx-nonce": nonce,
          "bfx-apikey": apiKey,
          "bfx-signature": signature,
          "Content-Type": "application/json"
        },
        body: bodyStr
      });
      const data = await res.json();
      if (Array.isArray(data) && data[0] === "error") {
        lastError = `API Error: ${data[2] ?? data[1]}`;
        if (attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1e3);
          continue;
        }
        throw new Error(lastError);
      }
      return data;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 1e3);
      }
    }
  }
  throw new Error(lastError);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// server/lib/funding.ts
var PUBLIC_API = "https://api-pub.bitfinex.com";
function normalizeCurrency(input) {
  const raw = input.trim().toUpperCase();
  const walletCurrency = raw === "USDT" ? "UST" : raw;
  return { walletCurrency, symbol: `f${walletCurrency}` };
}
async function fetchFrr(symbol) {
  const res = await fetch(`${PUBLIC_API}/v2/tickers?symbols=${encodeURIComponent(symbol)}`);
  const data = await res.json();
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error(`\u7121\u6CD5\u89E3\u6790 ${symbol} ticker \u56DE\u61C9: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const frr = data[0][1];
  if (typeof frr !== "number" || !Number.isFinite(frr) || frr <= 0) {
    throw new Error(`${symbol} FRR \u6578\u503C\u7570\u5E38: ${String(frr)}`);
  }
  return frr;
}
async function fetchFundingWallet(apiKey, apiSecret, walletCurrency) {
  const data = await bitfinexAuthRequest(apiKey, apiSecret, "v2/auth/r/wallets");
  if (!Array.isArray(data)) return { balance: 0, available: null };
  for (const wallet of data) {
    if (!Array.isArray(wallet)) continue;
    if (wallet[0] !== "funding" || wallet[1] !== walletCurrency) continue;
    return {
      balance: typeof wallet[2] === "number" ? wallet[2] : 0,
      // Bitfinex 有時會回 null，此時不可當成 0 以外的值猜測
      available: typeof wallet[4] === "number" ? wallet[4] : null
    };
  }
  return { balance: 0, available: 0 };
}
async function fetchActiveFundingOffers(apiKey, apiSecret, symbol) {
  const data = await bitfinexAuthRequest(
    apiKey,
    apiSecret,
    `v2/auth/r/funding/offers/${symbol}`
  );
  if (!Array.isArray(data)) return [];
  const offers = [];
  for (const row of data) {
    if (!Array.isArray(row)) continue;
    const id = row[0];
    const amount = row[4];
    const rate = row[14];
    const period = row[15];
    if (typeof id !== "number" || typeof amount !== "number" || typeof rate !== "number" || typeof period !== "number") {
      continue;
    }
    offers.push({ id, symbol, amount: Math.abs(amount), rate, period });
  }
  return offers;
}
async function submitFundingOffer(apiKey, apiSecret, symbol, amount, rate, period) {
  const data = await bitfinexAuthRequest(
    apiKey,
    apiSecret,
    "v2/auth/w/funding/offer/submit",
    {
      type: "LIMIT",
      symbol,
      amount: amount.toFixed(2),
      rate: rate.toFixed(8),
      period
    }
  );
  assertNotificationOk(data, `\u639B\u55AE ${amount.toFixed(2)} @ ${rate.toFixed(8)}`);
}
async function cancelFundingOffer(apiKey, apiSecret, id) {
  const data = await bitfinexAuthRequest(
    apiKey,
    apiSecret,
    "v2/auth/w/funding/offer/cancel",
    { id }
  );
  assertNotificationOk(data, `\u64A4\u55AE #${id}`);
}
function assertNotificationOk(data, label) {
  if (!Array.isArray(data)) return;
  if (data[6] === "ERROR") {
    throw new Error(`${label} \u5931\u6557: ${String(data[7] ?? "unknown error")}`);
  }
}

// server/lib/telegram.ts
async function sendTelegramMessage(botToken, chatId, text, retries = 3) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML"
        })
      });
      const data = await res.json();
      if (data.ok) {
        return { success: true };
      }
      const errMsg = data.description ?? "Unknown Telegram error";
      if (attempt < retries) {
        await sleep2(Math.pow(2, attempt) * 1e3);
        continue;
      }
      return { success: false, error: errMsg };
    } catch (err) {
      if (attempt < retries) {
        await sleep2(Math.pow(2, attempt) * 1e3);
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: errorMsg };
      }
    }
  }
  return { success: false, error: "Max retries exceeded" };
}
function sleep2(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// server/cron/funding-bot.ts
function loadAccounts(env = process.env) {
  const ids = (env.FUNDING_BOT_ACCOUNTS ?? "1").split(",").map((s) => s.trim()).filter(Boolean);
  const accounts = [];
  const seenKeys = /* @__PURE__ */ new Set();
  for (const id of ids) {
    const key = env[`FUNDING_BOT_ACCOUNT${id}_KEY`] || (id === "1" ? env.FUNDING_BOT_API_KEY : void 0) || env[`BITFINEX_ACCOUNT${id}_KEY`] || "";
    const secret = env[`FUNDING_BOT_ACCOUNT${id}_SECRET`] || (id === "1" ? env.FUNDING_BOT_API_SECRET : void 0) || env[`BITFINEX_ACCOUNT${id}_SECRET`] || "";
    const name = env[`BITFINEX_ACCOUNT${id}_NAME`] || `\u5E33\u6236 ${id}`;
    if (!key || !secret) {
      console.warn(`[FundingBot] ${name} \u7F3A\u5C11 API \u91D1\u9470\uFF0C\u7565\u904E`);
      continue;
    }
    if (seenKeys.has(key)) {
      console.warn(`[FundingBot] ${name} \u7684\u91D1\u9470\u8207\u5176\u4ED6\u5E33\u6236\u91CD\u8907\uFF0C\u7565\u904E\u4EE5\u514D\u4F75\u767C\u64CD\u4F5C\u540C\u4E00\u628A key`);
      continue;
    }
    seenKeys.add(key);
    accounts.push({ name, key, secret });
  }
  return accounts;
}
function envNum(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
function envBool(name, fallback) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}
function sleep3(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function loadStrategyConfig() {
  const ladderRaw = process.env.FUNDING_BOT_LADDER?.trim();
  const parsed = ladderRaw ? parseLadder(ladderRaw) : null;
  if (ladderRaw && !parsed) {
    console.warn(`[FundingBot] FUNDING_BOT_LADDER \u683C\u5F0F\u7121\u6548\uFF0C\u6539\u7528\u9810\u8A2D ladder: ${ladderRaw}`);
  }
  return {
    tiers: parsed ?? DEFAULT_LADDER,
    minRateApy: envNum("FUNDING_BOT_MIN_RATE_APY", 6),
    frrFloorMult: envNum("FUNDING_BOT_FRR_FLOOR_MULT", 0.8),
    basePeriodDays: Math.round(envNum("FUNDING_BOT_PERIOD_DAYS", 2)),
    // 研究與實測皆顯示 15% 以上即值得拉長天期鎖利，原本的 25% 門檻過高
    spikeApy: envNum("FUNDING_BOT_SPIKE_APY", 15),
    spikePeriodDays: Math.round(envNum("FUNDING_BOT_SPIKE_PERIOD", 30)),
    minOfferAmount: envNum("FUNDING_BOT_MIN_OFFER", BITFINEX_MIN_FUNDING_OFFER),
    maxOffers: Math.round(envNum("FUNDING_BOT_MAX_OFFERS", 5))
  };
}
async function runForCurrency(apiKey, apiSecret, currencyInput, cfg, dryRun) {
  const { walletCurrency, symbol } = normalizeCurrency(currencyInput);
  const base = { currency: walletCurrency, symbol, changed: false };
  try {
    const frr = await fetchFrr(symbol);
    const frrApy = dailyRateToApy(frr);
    const wallet = await fetchFundingWallet(apiKey, apiSecret, walletCurrency);
    if (wallet.available === null) {
      return { ...base, frrApy, note: "API \u672A\u63D0\u4F9B\u53EF\u7528\u9918\u984D\uFF0C\u672C\u6B21\u8DF3\u904E" };
    }
    const offers = await fetchActiveFundingOffers(apiKey, apiSecret, symbol);
    const openTotal = offers.reduce((sum, o) => sum + o.amount, 0);
    const deployable = wallet.available + openTotal;
    const desired = planOffers(deployable, frr, cfg);
    const planned = desired.map((d) => ({
      amount: d.amount,
      rateApy: dailyRateToApy(d.rate),
      period: d.period
    }));
    const snapshot = {
      ...base,
      frrApy,
      available: wallet.available,
      deployable,
      planned
    };
    if (desired.length === 0) {
      return { ...snapshot, note: "\u53EF\u4F48\u7F72\u8CC7\u91D1\u4E0D\u8DB3\u6216 FRR \u7570\u5E38\uFF0C\u672A\u7522\u751F\u5831\u50F9" };
    }
    if (!needsRequote(offers, desired)) {
      return { ...snapshot, note: "\u73FE\u6709\u639B\u55AE\u4ECD\u5728\u5BB9\u5FCD\u7BC4\u570D\u5167\uFF0C\u7DAD\u6301\u4E0D\u52D5" };
    }
    if (dryRun) {
      return { ...snapshot, note: "dry-run\uFF1A\u50C5\u8A08\u7B97\uFF0C\u672A\u5BE6\u969B\u4E0B\u55AE" };
    }
    let cancelled = 0;
    for (const offer of offers) {
      await cancelFundingOffer(apiKey, apiSecret, offer.id);
      cancelled++;
    }
    if (cancelled > 0) await sleep3(1500);
    let placed = 0;
    const errors = [];
    for (const offer of desired) {
      try {
        await submitFundingOffer(apiKey, apiSecret, symbol, offer.amount, offer.rate, offer.period);
        placed++;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }
    return {
      ...snapshot,
      cancelled,
      placed,
      changed: placed > 0 || cancelled > 0,
      error: errors.length > 0 ? errors.join("; ") : void 0
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}
async function runForAccount(account, currencies, cfg, dryRun) {
  const results = [];
  for (const currency of currencies) {
    const result = await runForCurrency(account.key, account.secret, currency, cfg, dryRun);
    results.push(result);
    if (result.error) {
      console.error(`[FundingBot] ${account.name} / ${result.currency} \u5931\u6557: ${result.error}`);
    } else {
      console.log(
        `[FundingBot] ${account.name} / ${result.currency}: FRR ${result.frrApy?.toFixed(2)}% APY, \u53EF\u4F48\u7F72 ${result.deployable?.toFixed(2)}, ${result.note ?? `\u64A4 ${result.cancelled} \u639B ${result.placed}`}`
      );
    }
  }
  return { account: account.name, currencies: results };
}
function formatReport(result) {
  let message = `\u{1F916} <b>Bitfinex \u653E\u8CB8\u6A5F\u5668\u4EBA</b>
`;
  if (result.dryRun) message += `\u{1F9EA} <i>dry-run \u6A21\u5F0F\uFF08\u672A\u5BE6\u969B\u4E0B\u55AE\uFF09</i>
`;
  message += `
`;
  for (const acc of result.accounts) {
    message += `\u2501\u2501 <b>${acc.account}</b> \u2501\u2501
`;
    message += formatCurrencies(acc.currencies);
  }
  return message.trimEnd();
}
function formatCurrencies(currencies) {
  let message = "";
  for (const c of currencies) {
    message += `<b>${c.currency}</b>
`;
    if (c.error) {
      message += `\u274C ${c.error}

`;
      continue;
    }
    if (c.frrApy !== void 0) {
      message += `\u2022 FRR: ${c.frrApy.toFixed(2)}% APY
`;
    }
    if (c.available !== void 0 && c.deployable !== void 0) {
      message += `\u2022 \u9592\u7F6E ${c.available.toFixed(2)} / \u53EF\u4F48\u7F72 ${c.deployable.toFixed(2)}
`;
    }
    if (c.planned && c.planned.length > 0) {
      message += `\u2022 \u5831\u50F9\uFF1A
`;
      for (const p of c.planned) {
        message += `   ${p.amount.toFixed(2)} @ ${p.rateApy.toFixed(2)}% (${p.period}\u5929)
`;
      }
    }
    if (c.changed) {
      message += `\u2705 \u64A4\u55AE ${c.cancelled ?? 0} \u7B46\u3001\u639B\u55AE ${c.placed ?? 0} \u7B46
`;
    } else if (c.note) {
      message += `\u23F8 ${c.note}
`;
    }
    message += `
`;
  }
  return message;
}
async function runFundingBot() {
  const startTime = Date.now();
  const enabled = envBool("FUNDING_BOT_ENABLED", false);
  const dryRun = envBool("FUNDING_BOT_DRY_RUN", true);
  if (!enabled) {
    console.log("[FundingBot] \u672A\u555F\u7528\uFF08\u8A2D\u5B9A FUNDING_BOT_ENABLED=true \u4EE5\u555F\u7528\uFF09");
    return { success: true, enabled: false, dryRun, accounts: [] };
  }
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    const error = "\u6C92\u6709\u53EF\u7528\u7684\u5E33\u6236\uFF1A\u8ACB\u8A2D\u5B9A FUNDING_BOT_ACCOUNT{N}_KEY / _SECRET";
    console.error(`[FundingBot] ${error}`);
    return { success: false, enabled, dryRun, error, accounts: [] };
  }
  const cfg = loadStrategyConfig();
  const currencies = (process.env.FUNDING_BOT_CURRENCIES ?? "USD").split(",").map((c) => c.trim()).filter(Boolean);
  console.log(
    `[FundingBot] \u958B\u59CB\u57F7\u884C\uFF08dryRun=${dryRun}, \u5E33\u6236=${accounts.length}, \u5E63\u5225=${currencies.join(",")}\uFF09- ${(/* @__PURE__ */ new Date()).toISOString()}`
  );
  const accountResults = await Promise.all(
    accounts.map((account) => runForAccount(account, currencies, cfg, dryRun))
  );
  const flat = accountResults.flatMap((a) => a.currencies);
  const elapsed = `${((Date.now() - startTime) / 1e3).toFixed(2)}s`;
  const result = {
    success: flat.every((r) => !r.error),
    enabled,
    dryRun,
    elapsed,
    accounts: accountResults
  };
  const notify = (process.env.FUNDING_BOT_NOTIFY ?? "changes").trim().toLowerCase();
  const hasNews = flat.some((r) => r.changed || r.error);
  const shouldNotify = notify === "always" || notify === "changes" && hasNews;
  if (shouldNotify) {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
    if (token && chatId) {
      await sendTelegramMessage(token, chatId, formatReport(result));
    }
  }
  console.log(`[FundingBot] \u5B8C\u6210\uFF08\u8017\u6642 ${elapsed}\uFF09`);
  return result;
}

// server/funding-bot-vercel-entry.ts
async function handler(req, res) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[FundingBot] \u672A\u8A2D\u5B9A CRON_SECRET\uFF0C\u62D2\u7D55\u57F7\u884C");
    return res.status(500).json({
      success: false,
      error: "\u4F3A\u670D\u5668\u672A\u8A2D\u5B9A CRON_SECRET\uFF0C\u653E\u8CB8\u7AEF\u9EDE\u5DF2\u505C\u7528"
    });
  }
  const authHeader = req.headers["authorization"];
  const querySecret = typeof req.query?.secret === "string" ? req.query.secret : void 0;
  const authorized = authHeader === `Bearer ${cronSecret}` || querySecret === cronSecret;
  if (!authorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await runFundingBot();
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[FundingBot] \u57F7\u884C\u5931\u6557:", errorMsg);
    return res.status(500).json({ success: false, error: errorMsg });
  }
}
export {
  handler as default
};
