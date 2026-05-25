import crypto from "crypto";

// Bitfinex 要求同一 API key 的 nonce 嚴格遞增；用全域單調計數器避免同毫秒碰撞。
let lastNonce = 0;
function nextNonce(): string {
  let nonce = Date.now() * 1000;
  if (nonce <= lastNonce) {
    nonce = lastNonce + 1;
  }
  lastNonce = nonce;
  return nonce.toString();
}

export interface InterestResult {
  accountName: string;
  totalInterest: number;
  /** funding 錢包本金 (USD)，查詢失敗或無資料時為 0 */
  principal?: number;
  currency: string;
  entries: number;
  error?: string;
}

/**
 * 查詢指定帳戶過去 24 小時的借貸利息
 * category=28 代表 margin/swap/interest payment
 */
export async function fetchDailyInterest(
  apiKey: string,
  apiSecret: string,
  accountName: string,
  retries = 3
): Promise<InterestResult> {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1000;
  // apiPath 格式：v2/auth/r/ledgers/hist（不含前導 /）
  const apiPath = "v2/auth/r/ledgers/hist";
  const bodyStr = JSON.stringify({ category: 28, limit: 2500, start, end: now });

  for (let attempt = 1; attempt <= retries; attempt++) {
    // 每次嘗試都用新的遞增 nonce，避免重試時 nonce 過小
    const nonce = nextNonce();
    // 官方簽名格式：/api/ + apiPath + nonce + body
    const signaturePayload = `/api/${apiPath}${nonce}${bodyStr}`;
    const signature = crypto.createHmac("sha384", apiSecret).update(signaturePayload).digest("hex");
    const headers = {
      "bfx-nonce": nonce,
      "bfx-apikey": apiKey,
      "bfx-signature": signature,
      "Content-Type": "application/json",
    };

    try {
      const res = await fetch(`https://api.bitfinex.com/${apiPath}`, {
        method: "POST",
        headers,
        body: bodyStr,
      });

      const data = await res.json() as unknown[];

      if (!Array.isArray(data)) {
        throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
      }

      // 檢查是否為錯誤回應 ["error", code, "message"]
      if ((data as unknown[])[0] === "error") {
        const errMsg = `API Error: ${data[2]}`;
        if (attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        return { accountName, totalInterest: 0, currency: "USD", entries: 0, error: errMsg };
      }

      // 計算正向利息總額
      // Bitfinex ledger 格式: [ID, CURRENCY, null, MTS, null, AMOUNT, BALANCE, null, DESCRIPTION]
      let totalInterest = 0;
      let entries = 0;
      for (const entry of data) {
        if (Array.isArray(entry) && (entry as unknown[]).length > 5) {
          const amount = (entry as unknown[])[5];
          if (typeof amount === "number" && amount > 0) {
            totalInterest += amount;
            entries++;
          }
        }
      }

      return { accountName, totalInterest, currency: "USD", entries };
    } catch (err) {
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 1000);
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { accountName, totalInterest: 0, currency: "USD", entries: 0, error: errorMsg };
      }
    }
  }

  return { accountName, totalInterest: 0, currency: "USD", entries: 0, error: "Max retries exceeded" };
}

/**
 * 查詢指定帳戶的 funding（放貸）錢包餘額，作為計算年化報酬率的本金。
 * 加總所有 funding 錢包餘額（視為 USD 等值），查詢失敗回傳 0。
 * wallet 格式: [WALLET_TYPE, CURRENCY, BALANCE, UNSETTLED_INTEREST, AVAILABLE_BALANCE, ...]
 */
export async function fetchFundingBalance(
  apiKey: string,
  apiSecret: string,
  retries = 3
): Promise<number> {
  const apiPath = "v2/auth/r/wallets";
  const bodyStr = "{}";

  for (let attempt = 1; attempt <= retries; attempt++) {
    const nonce = nextNonce();
    const signaturePayload = `/api/${apiPath}${nonce}${bodyStr}`;
    const signature = crypto.createHmac("sha384", apiSecret).update(signaturePayload).digest("hex");
    const headers = {
      "bfx-nonce": nonce,
      "bfx-apikey": apiKey,
      "bfx-signature": signature,
      "Content-Type": "application/json",
    };

    try {
      const res = await fetch(`https://api.bitfinex.com/${apiPath}`, {
        method: "POST",
        headers,
        body: bodyStr,
      });

      const data = (await res.json()) as unknown[];

      if (!Array.isArray(data)) {
        throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
      }

      if (data[0] === "error") {
        if (attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1000);
          continue;
        }
        return 0;
      }

      let principal = 0;
      for (const wallet of data) {
        if (Array.isArray(wallet) && wallet[0] === "funding" && typeof wallet[2] === "number") {
          principal += wallet[2];
        }
      }
      return principal;
    } catch {
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 1000);
      } else {
        return 0;
      }
    }
  }

  return 0;
}

/**
 * 並行查詢多個帳戶的利息與 funding 本金
 */
export async function fetchAllAccountsInterest(accounts: {
  key: string;
  secret: string;
  name: string;
}[]): Promise<InterestResult[]> {
  // 不同帳戶（不同 API key）可並行；但同一帳戶的兩個請求必須序列化，
  // 否則同一 key 的並發請求會觸發 Bitfinex「nonce: small」錯誤。
  return Promise.all(
    accounts.map(async (acc) => {
      const interest = await fetchDailyInterest(acc.key, acc.secret, acc.name);
      const principal = await fetchFundingBalance(acc.key, acc.secret);
      return { ...interest, principal };
    })
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
