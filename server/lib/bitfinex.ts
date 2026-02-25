import crypto from "crypto";

export interface InterestResult {
  accountName: string;
  totalInterest: number;
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
  // 官方文件要求 nonce 為微秒（Date.now() * 1000）
  const nonce = (now * 1000).toString();
  // apiPath 格式：v2/auth/r/ledgers/hist（不含前導 /）
  const apiPath = "v2/auth/r/ledgers/hist";
  const bodyStr = JSON.stringify({ category: 28, limit: 2500, start, end: now });
  // 官方簽名格式：/api/ + apiPath + nonce + body
  const signaturePayload = `/api/${apiPath}${nonce}${bodyStr}`;
  const signature = crypto.createHmac("sha384", apiSecret).update(signaturePayload).digest("hex");

  const headers = {
    "bfx-nonce": nonce,
    "bfx-apikey": apiKey,
    "bfx-signature": signature,
    "Content-Type": "application/json",
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
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
 * 並行查詢兩個帳戶的利息
 */
export async function fetchAllAccountsInterest(accounts: {
  key: string;
  secret: string;
  name: string;
}[]): Promise<InterestResult[]> {
  return Promise.all(
    accounts.map((acc) => fetchDailyInterest(acc.key, acc.secret, acc.name))
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
