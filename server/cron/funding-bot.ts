/**
 * Bitfinex 放貸機器人
 *
 * 每次執行會：讀取 FRR 與可用餘額 → 算出 ladder 報價 → 判斷是否值得重掛 →
 * （非 dry-run 時）撤銷舊掛單並送出新掛單 → 視設定發送 Telegram 摘要。
 *
 * 安全預設：未設定 FUNDING_BOT_ENABLED=true 不會執行；即使啟用，
 * 預設仍為 dry-run（只計算與記錄，不會真的下單）。
 */
import {
  DEFAULT_LADDER,
  dailyRateToApy,
  needsRequote,
  parseLadder,
  planOffers,
  type StrategyConfig,
} from "../lib/funding-strategy";
import {
  cancelFundingOffer,
  fetchActiveFundingOffers,
  fetchFrr,
  fetchFundingWallet,
  normalizeCurrency,
  submitFundingOffer,
} from "../lib/funding";
import { sendTelegramMessage } from "../lib/telegram";

export interface PlannedOffer {
  amount: number;
  rateApy: number;
  period: number;
}

export interface FundingBotCurrencyResult {
  currency: string;
  symbol: string;
  frrApy?: number;
  available?: number;
  deployable?: number;
  planned?: PlannedOffer[];
  cancelled?: number;
  placed?: number;
  changed: boolean;
  note?: string;
  error?: string;
}

export interface FundingBotResult {
  success: boolean;
  enabled: boolean;
  dryRun: boolean;
  elapsed?: string;
  currencies: FundingBotCurrencyResult[];
  error?: string;
}

function envNum(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function loadStrategyConfig(): StrategyConfig {
  const ladderRaw = process.env.FUNDING_BOT_LADDER?.trim();
  const parsed = ladderRaw ? parseLadder(ladderRaw) : null;

  if (ladderRaw && !parsed) {
    console.warn(`[FundingBot] FUNDING_BOT_LADDER 格式無效，改用預設 ladder: ${ladderRaw}`);
  }

  return {
    tiers: parsed ?? DEFAULT_LADDER,
    minRateApy: envNum("FUNDING_BOT_MIN_RATE_APY", 6),
    frrFloorMult: envNum("FUNDING_BOT_FRR_FLOOR_MULT", 0.8),
    basePeriodDays: Math.round(envNum("FUNDING_BOT_PERIOD_DAYS", 2)),
    spikeApy: envNum("FUNDING_BOT_SPIKE_APY", 25),
    spikePeriodDays: Math.round(envNum("FUNDING_BOT_SPIKE_PERIOD", 30)),
    minOfferAmount: envNum("FUNDING_BOT_MIN_OFFER", 50),
    maxOffers: Math.round(envNum("FUNDING_BOT_MAX_OFFERS", 5)),
  };
}

/** 處理單一幣別。所有 API 呼叫都是序列的，避免 nonce 競爭。 */
async function runForCurrency(
  apiKey: string,
  apiSecret: string,
  currencyInput: string,
  cfg: StrategyConfig,
  dryRun: boolean
): Promise<FundingBotCurrencyResult> {
  const { walletCurrency, symbol } = normalizeCurrency(currencyInput);
  const base: FundingBotCurrencyResult = { currency: walletCurrency, symbol, changed: false };

  try {
    const frr = await fetchFrr(symbol);
    const frrApy = dailyRateToApy(frr);

    const wallet = await fetchFundingWallet(apiKey, apiSecret, walletCurrency);
    if (wallet.available === null) {
      return { ...base, frrApy, note: "API 未提供可用餘額，本次跳過" };
    }

    const offers = await fetchActiveFundingOffers(apiKey, apiSecret, symbol);
    const openTotal = offers.reduce((sum, o) => sum + o.amount, 0);
    // 可佈署 = 閒置資金 + 尚未成交的掛單（已借出的部分無法動用）
    const deployable = wallet.available + openTotal;

    const desired = planOffers(deployable, frr, cfg);
    const planned: PlannedOffer[] = desired.map((d) => ({
      amount: d.amount,
      rateApy: dailyRateToApy(d.rate),
      period: d.period,
    }));

    const snapshot = {
      ...base,
      frrApy,
      available: wallet.available,
      deployable,
      planned,
    };

    if (desired.length === 0) {
      return { ...snapshot, note: "可佈署資金不足或 FRR 異常，未產生報價" };
    }

    if (!needsRequote(offers, desired)) {
      return { ...snapshot, note: "現有掛單仍在容忍範圍內，維持不動" };
    }

    if (dryRun) {
      return { ...snapshot, note: "dry-run：僅計算，未實際下單" };
    }

    let cancelled = 0;
    for (const offer of offers) {
      await cancelFundingOffer(apiKey, apiSecret, offer.id);
      cancelled++;
    }

    // 撤單後資金釋放需要一點時間，稍等再掛單以免「餘額不足」
    if (cancelled > 0) await sleep(1500);

    let placed = 0;
    const errors: string[] = [];
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
      error: errors.length > 0 ? errors.join("; ") : undefined,
    };
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }
}

function formatReport(result: FundingBotResult): string {
  let message = `🤖 <b>Bitfinex 放貸機器人</b>\n`;
  if (result.dryRun) message += `🧪 <i>dry-run 模式（未實際下單）</i>\n`;
  message += `\n`;

  for (const c of result.currencies) {
    message += `<b>${c.currency}</b>\n`;

    if (c.error) {
      message += `❌ ${c.error}\n\n`;
      continue;
    }

    if (c.frrApy !== undefined) {
      message += `• FRR: ${c.frrApy.toFixed(2)}% APY\n`;
    }
    if (c.available !== undefined && c.deployable !== undefined) {
      message += `• 閒置 ${c.available.toFixed(2)} / 可佈署 ${c.deployable.toFixed(2)}\n`;
    }

    if (c.planned && c.planned.length > 0) {
      message += `• 報價：\n`;
      for (const p of c.planned) {
        message += `   ${p.amount.toFixed(2)} @ ${p.rateApy.toFixed(2)}% (${p.period}天)\n`;
      }
    }

    if (c.changed) {
      message += `✅ 撤單 ${c.cancelled ?? 0} 筆、掛單 ${c.placed ?? 0} 筆\n`;
    } else if (c.note) {
      message += `⏸ ${c.note}\n`;
    }

    message += `\n`;
  }

  return message.trimEnd();
}

export async function runFundingBot(): Promise<FundingBotResult> {
  const startTime = Date.now();
  const enabled = envBool("FUNDING_BOT_ENABLED", false);
  const dryRun = envBool("FUNDING_BOT_DRY_RUN", true);

  if (!enabled) {
    console.log("[FundingBot] 未啟用（設定 FUNDING_BOT_ENABLED=true 以啟用）");
    return { success: true, enabled: false, dryRun, currencies: [] };
  }

  const apiKey = process.env.FUNDING_BOT_API_KEY ?? process.env.BITFINEX_ACCOUNT1_KEY ?? "";
  const apiSecret =
    process.env.FUNDING_BOT_API_SECRET ?? process.env.BITFINEX_ACCOUNT1_SECRET ?? "";

  if (!apiKey || !apiSecret) {
    const error = "缺少 API 金鑰（FUNDING_BOT_API_KEY / FUNDING_BOT_API_SECRET）";
    console.error(`[FundingBot] ${error}`);
    return { success: false, enabled, dryRun, error, currencies: [] };
  }

  const cfg = loadStrategyConfig();
  const currencies = (process.env.FUNDING_BOT_CURRENCIES ?? "USD")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  console.log(
    `[FundingBot] 開始執行（dryRun=${dryRun}, 幣別=${currencies.join(",")}）- ${new Date().toISOString()}`
  );

  const results: FundingBotCurrencyResult[] = [];
  for (const currency of currencies) {
    const result = await runForCurrency(apiKey, apiSecret, currency, cfg, dryRun);
    results.push(result);

    if (result.error) {
      console.error(`[FundingBot] ${result.currency} 失敗: ${result.error}`);
    } else {
      console.log(
        `[FundingBot] ${result.currency}: FRR ${result.frrApy?.toFixed(2)}% APY, ` +
          `可佈署 ${result.deployable?.toFixed(2)}, ${result.note ?? `撤 ${result.cancelled} 掛 ${result.placed}`}`
      );
    }
  }

  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
  const result: FundingBotResult = {
    success: results.every((r) => !r.error),
    enabled,
    dryRun,
    elapsed,
    currencies: results,
  };

  // 通知策略：預設只在有變動或出錯時發送，避免每 15 分鐘洗版
  const notify = (process.env.FUNDING_BOT_NOTIFY ?? "changes").trim().toLowerCase();
  const hasNews = results.some((r) => r.changed || r.error);
  const shouldNotify = notify === "always" || (notify === "changes" && hasNews);

  if (shouldNotify) {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
    if (token && chatId) {
      await sendTelegramMessage(token, chatId, formatReport(result));
    }
  }

  console.log(`[FundingBot] 完成（耗時 ${elapsed}）`);
  return result;
}
