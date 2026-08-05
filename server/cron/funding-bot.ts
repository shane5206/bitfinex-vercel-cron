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
  BITFINEX_MIN_FUNDING_OFFER,
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

export interface FundingBotAccountResult {
  account: string;
  currencies: FundingBotCurrencyResult[];
}

export interface FundingBotResult {
  success: boolean;
  enabled: boolean;
  dryRun: boolean;
  elapsed?: string;
  accounts: FundingBotAccountResult[];
  error?: string;
}

/** 機器人要操作的其中一個 Bitfinex 帳戶 */
export interface BotAccount {
  name: string;
  key: string;
  secret: string;
}

/**
 * 解析要操作哪些帳戶。金鑰查找順序（由專用到通用）：
 *   1. FUNDING_BOT_ACCOUNT{N}_KEY／SECRET（建議：只開放貸權限的專用金鑰）
 *   2. FUNDING_BOT_API_KEY／SECRET（僅限帳戶 1，向下相容單帳戶設定）
 *   3. BITFINEX_ACCOUNT{N}_KEY／SECRET（沿用每日報告的金鑰，可能是唯讀）
 *
 * 傳入 env 便於測試；金鑰重複的帳戶會被略過，避免同一把 key 被並行操作。
 */
export function loadAccounts(
  env: Record<string, string | undefined> = process.env
): BotAccount[] {
  const ids = (env.FUNDING_BOT_ACCOUNTS ?? "1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const accounts: BotAccount[] = [];
  const seenKeys = new Set<string>();

  for (const id of ids) {
    const key =
      env[`FUNDING_BOT_ACCOUNT${id}_KEY`] ||
      (id === "1" ? env.FUNDING_BOT_API_KEY : undefined) ||
      env[`BITFINEX_ACCOUNT${id}_KEY`] ||
      "";
    const secret =
      env[`FUNDING_BOT_ACCOUNT${id}_SECRET`] ||
      (id === "1" ? env.FUNDING_BOT_API_SECRET : undefined) ||
      env[`BITFINEX_ACCOUNT${id}_SECRET`] ||
      "";
    const name = env[`BITFINEX_ACCOUNT${id}_NAME`] || `帳戶 ${id}`;

    if (!key || !secret) {
      console.warn(`[FundingBot] ${name} 缺少 API 金鑰，略過`);
      continue;
    }
    if (seenKeys.has(key)) {
      console.warn(`[FundingBot] ${name} 的金鑰與其他帳戶重複，略過以免併發操作同一把 key`);
      continue;
    }

    seenKeys.add(key);
    accounts.push({ name, key, secret });
  }

  return accounts;
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
    minOfferAmount: envNum("FUNDING_BOT_MIN_OFFER", BITFINEX_MIN_FUNDING_OFFER),
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

/** 處理單一帳戶：幣別之間必須序列執行，避免同一把 key 的 nonce 競爭 */
async function runForAccount(
  account: BotAccount,
  currencies: string[],
  cfg: StrategyConfig,
  dryRun: boolean
): Promise<FundingBotAccountResult> {
  const results: FundingBotCurrencyResult[] = [];

  for (const currency of currencies) {
    const result = await runForCurrency(account.key, account.secret, currency, cfg, dryRun);
    results.push(result);

    if (result.error) {
      console.error(`[FundingBot] ${account.name} / ${result.currency} 失敗: ${result.error}`);
    } else {
      console.log(
        `[FundingBot] ${account.name} / ${result.currency}: FRR ${result.frrApy?.toFixed(2)}% APY, ` +
          `可佈署 ${result.deployable?.toFixed(2)}, ` +
          `${result.note ?? `撤 ${result.cancelled} 掛 ${result.placed}`}`
      );
    }
  }

  return { account: account.name, currencies: results };
}

function formatReport(result: FundingBotResult): string {
  let message = `🤖 <b>Bitfinex 放貸機器人</b>\n`;
  if (result.dryRun) message += `🧪 <i>dry-run 模式（未實際下單）</i>\n`;
  message += `\n`;

  for (const acc of result.accounts) {
    message += `━━ <b>${acc.account}</b> ━━\n`;
    message += formatCurrencies(acc.currencies);
  }

  return message.trimEnd();
}

function formatCurrencies(currencies: FundingBotCurrencyResult[]): string {
  let message = "";

  for (const c of currencies) {
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

  return message;
}

export async function runFundingBot(): Promise<FundingBotResult> {
  const startTime = Date.now();
  const enabled = envBool("FUNDING_BOT_ENABLED", false);
  const dryRun = envBool("FUNDING_BOT_DRY_RUN", true);

  if (!enabled) {
    console.log("[FundingBot] 未啟用（設定 FUNDING_BOT_ENABLED=true 以啟用）");
    return { success: true, enabled: false, dryRun, accounts: [] };
  }

  const accounts = loadAccounts();
  if (accounts.length === 0) {
    const error = "沒有可用的帳戶：請設定 FUNDING_BOT_ACCOUNT{N}_KEY / _SECRET";
    console.error(`[FundingBot] ${error}`);
    return { success: false, enabled, dryRun, error, accounts: [] };
  }

  const cfg = loadStrategyConfig();
  const currencies = (process.env.FUNDING_BOT_CURRENCIES ?? "USD")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  console.log(
    `[FundingBot] 開始執行（dryRun=${dryRun}, 帳戶=${accounts.length}, ` +
      `幣別=${currencies.join(",")}）- ${new Date().toISOString()}`
  );

  // 不同帳戶使用不同 API key，Bitfinex 的 nonce 是各金鑰獨立驗證，
  // 因此帳戶之間可安全並行；帳戶內部的幣別仍維持序列執行。
  const accountResults = await Promise.all(
    accounts.map((account) => runForAccount(account, currencies, cfg, dryRun))
  );

  const flat = accountResults.flatMap((a) => a.currencies);
  const elapsed = `${((Date.now() - startTime) / 1000).toFixed(2)}s`;
  const result: FundingBotResult = {
    success: flat.every((r) => !r.error),
    enabled,
    dryRun,
    elapsed,
    accounts: accountResults,
  };

  // 通知策略：預設只在有變動或出錯時發送，避免每 15 分鐘洗版
  const notify = (process.env.FUNDING_BOT_NOTIFY ?? "changes").trim().toLowerCase();
  const hasNews = flat.some((r) => r.changed || r.error);
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
