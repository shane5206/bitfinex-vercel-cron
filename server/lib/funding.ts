/**
 * Bitfinex Funding（放貸）API 封裝
 *
 * 重要：所有認證請求都必須「依序 await」，不可用 Promise.all 併發，
 * 否則同一把 API key 的 nonce 會互相競爭而觸發 nonce: small。
 */
import { bitfinexAuthRequest } from "./bitfinex";

const PUBLIC_API = "https://api-pub.bitfinex.com";

export interface FundingWallet {
  balance: number;
  /** 未被掛單/借出佔用的可動用餘額；API 未提供時為 null */
  available: number | null;
}

export interface FundingOffer {
  id: number;
  symbol: string;
  amount: number;
  /** 每日利率小數 */
  rate: number;
  period: number;
}

/**
 * 把使用者輸入的幣別轉成 Bitfinex 的錢包幣別代碼與 funding symbol。
 * 注意 Bitfinex v2 API 把 USDT 記為 UST。
 */
export function normalizeCurrency(input: string): { walletCurrency: string; symbol: string } {
  const raw = input.trim().toUpperCase();
  const walletCurrency = raw === "USDT" ? "UST" : raw;
  return { walletCurrency, symbol: `f${walletCurrency}` };
}

/**
 * 取得當前 FRR（每日利率小數）。使用公開端點，不需簽名。
 * funding ticker 格式：[SYMBOL, FRR, BID, BID_PERIOD, BID_SIZE, ASK, ...]
 */
export async function fetchFrr(symbol: string): Promise<number> {
  const res = await fetch(`${PUBLIC_API}/v2/tickers?symbols=${encodeURIComponent(symbol)}`);
  const data = (await res.json()) as unknown;

  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error(`無法解析 ${symbol} ticker 回應: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const frr = (data[0] as unknown[])[1];
  if (typeof frr !== "number" || !Number.isFinite(frr) || frr <= 0) {
    throw new Error(`${symbol} FRR 數值異常: ${String(frr)}`);
  }

  return frr;
}

/**
 * 取得 funding 錢包餘額。
 * wallet 格式：[WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED_INTEREST, AVAILABLE_BALANCE, ...]
 */
export async function fetchFundingWallet(
  apiKey: string,
  apiSecret: string,
  walletCurrency: string
): Promise<FundingWallet> {
  const data = await bitfinexAuthRequest<unknown[]>(apiKey, apiSecret, "v2/auth/r/wallets");
  if (!Array.isArray(data)) return { balance: 0, available: null };

  for (const wallet of data) {
    if (!Array.isArray(wallet)) continue;
    if (wallet[0] !== "funding" || wallet[1] !== walletCurrency) continue;

    return {
      balance: typeof wallet[2] === "number" ? wallet[2] : 0,
      // Bitfinex 有時會回 null，此時不可當成 0 以外的值猜測
      available: typeof wallet[4] === "number" ? wallet[4] : null,
    };
  }

  return { balance: 0, available: 0 };
}

/**
 * 取得尚未成交的放貸掛單（已借出的資金屬於 credits，不在此列，也無法撤銷）。
 * offer 格式：[ID, SYMBOL, MTS_CREATE, MTS_UPDATE, AMOUNT, AMOUNT_ORIG, TYPE, _, _,
 *              FLAGS, STATUS, _, _, _, RATE, PERIOD, ...]
 */
export async function fetchActiveFundingOffers(
  apiKey: string,
  apiSecret: string,
  symbol: string
): Promise<FundingOffer[]> {
  const data = await bitfinexAuthRequest<unknown[]>(
    apiKey,
    apiSecret,
    `v2/auth/r/funding/offers/${symbol}`
  );
  if (!Array.isArray(data)) return [];

  const offers: FundingOffer[] = [];
  for (const row of data) {
    if (!Array.isArray(row)) continue;

    const id = row[0];
    const amount = row[4];
    const rate = row[14];
    const period = row[15];

    if (
      typeof id !== "number" ||
      typeof amount !== "number" ||
      typeof rate !== "number" ||
      typeof period !== "number"
    ) {
      continue;
    }

    offers.push({ id, symbol, amount: Math.abs(amount), rate, period });
  }

  return offers;
}

/** 送出放貸掛單。rate 為每日利率小數。 */
export async function submitFundingOffer(
  apiKey: string,
  apiSecret: string,
  symbol: string,
  amount: number,
  rate: number,
  period: number
): Promise<void> {
  const data = await bitfinexAuthRequest<unknown[]>(
    apiKey,
    apiSecret,
    "v2/auth/w/funding/offer/submit",
    {
      type: "LIMIT",
      symbol,
      amount: amount.toFixed(2),
      rate: rate.toFixed(8),
      period,
    }
  );

  assertNotificationOk(data, `掛單 ${amount.toFixed(2)} @ ${rate.toFixed(8)}`);
}

/** 撤銷指定掛單 */
export async function cancelFundingOffer(
  apiKey: string,
  apiSecret: string,
  id: number
): Promise<void> {
  const data = await bitfinexAuthRequest<unknown[]>(
    apiKey,
    apiSecret,
    "v2/auth/w/funding/offer/cancel",
    { id }
  );

  assertNotificationOk(data, `撤單 #${id}`);
}

/**
 * 寫入類端點回傳 notification 格式：
 * [MTS, TYPE, MESSAGE_ID, _, NOTIFY_INFO, CODE, STATUS, TEXT]
 */
function assertNotificationOk(data: unknown, label: string): void {
  if (!Array.isArray(data)) return;

  if (data[6] === "ERROR") {
    throw new Error(`${label} 失敗: ${String(data[7] ?? "unknown error")}`);
  }
}
