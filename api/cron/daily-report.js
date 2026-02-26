// server/cron-vercel-entry.ts
import "dotenv/config";

// server/lib/bitfinex.ts
import crypto from "crypto";
async function fetchDailyInterest(apiKey, apiSecret, accountName, retries = 3) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1e3;
  const nonce = (now * 1e3).toString();
  const apiPath = "v2/auth/r/ledgers/hist";
  const bodyStr = JSON.stringify({ category: 28, limit: 2500, start, end: now });
  const signaturePayload = `/api/${apiPath}${nonce}${bodyStr}`;
  const signature = crypto.createHmac("sha384", apiSecret).update(signaturePayload).digest("hex");
  const headers = {
    "bfx-nonce": nonce,
    "bfx-apikey": apiKey,
    "bfx-signature": signature,
    "Content-Type": "application/json"
  };
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`https://api.bitfinex.com/${apiPath}`, {
        method: "POST",
        headers,
        body: bodyStr
      });
      const data = await res.json();
      if (!Array.isArray(data)) {
        throw new Error(`Unexpected response: ${JSON.stringify(data)}`);
      }
      if (data[0] === "error") {
        const errMsg = `API Error: ${data[2]}`;
        if (attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1e3);
          continue;
        }
        return { accountName, totalInterest: 0, currency: "USD", entries: 0, error: errMsg };
      }
      let totalInterest = 0;
      let entries = 0;
      for (const entry of data) {
        if (Array.isArray(entry) && entry.length > 5) {
          const amount = entry[5];
          if (typeof amount === "number" && amount > 0) {
            totalInterest += amount;
            entries++;
          }
        }
      }
      return { accountName, totalInterest, currency: "USD", entries };
    } catch (err) {
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 1e3);
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { accountName, totalInterest: 0, currency: "USD", entries: 0, error: errorMsg };
      }
    }
  }
  return { accountName, totalInterest: 0, currency: "USD", entries: 0, error: "Max retries exceeded" };
}
async function fetchAllAccountsInterest(accounts) {
  return Promise.all(
    accounts.map((acc) => fetchDailyInterest(acc.key, acc.secret, acc.name))
  );
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// server/lib/telegram.ts
function formatInterestReport(results, executedAt) {
  const dateStr = executedAt.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  const totalInterest = results.reduce((sum, r) => sum + r.totalInterest, 0);
  const successCount = results.filter((r) => !r.error).length;
  let message = `\u{1F4CA} <b>Bitfinex \u6BCF\u65E5\u5229\u606F\u5831\u544A</b>
`;
  message += `\u{1F5D3} <i>${dateStr} (\u53F0\u7063\u6642\u9593)</i>

`;
  for (const result of results) {
    if (result.error) {
      message += `<b>${result.accountName}:</b>
`;
      message += `\u274C \u67E5\u8A62\u5931\u6557: ${result.error}

`;
    } else {
      message += `<b>${result.accountName}:</b>
`;
      message += `\u{1F4B0} ${result.totalInterest.toFixed(8)} ${result.currency}`;
      message += result.entries > 0 ? ` (${result.entries} \u7B46)

` : `

`;
    }
  }
  message += `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501
`;
  message += `\u{1F4C8} <b>\u4ECA\u65E5\u7E3D\u5229\u606F:</b>
`;
  message += `\u{1F3AF} <b>${totalInterest.toFixed(8)} USD</b>
`;
  message += `<i>\u6210\u529F\u67E5\u8A62 ${successCount}/${results.length} \u500B\u5E33\u6236</i>`;
  return message;
}
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

// server/cron/daily-report.ts
async function runDailyReport() {
  const startTime = Date.now();
  console.log(`[CronJob] \u958B\u59CB\u57F7\u884C\u6BCF\u65E5\u5229\u606F\u5831\u544A - ${(/* @__PURE__ */ new Date()).toISOString()}`);
  const account1Key = process.env.BITFINEX_ACCOUNT1_KEY ?? "";
  const account1Secret = process.env.BITFINEX_ACCOUNT1_SECRET ?? "";
  const account1Name = process.env.BITFINEX_ACCOUNT1_NAME ?? "\u5E33\u6236 1";
  const account2Key = process.env.BITFINEX_ACCOUNT2_KEY ?? "";
  const account2Secret = process.env.BITFINEX_ACCOUNT2_SECRET ?? "";
  const account2Name = process.env.BITFINEX_ACCOUNT2_NAME ?? "\u5E33\u6236 2";
  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const telegramChatId = process.env.TELEGRAM_CHAT_ID ?? "";
  const missingVars = [];
  if (!account1Key) missingVars.push("BITFINEX_ACCOUNT1_KEY");
  if (!account1Secret) missingVars.push("BITFINEX_ACCOUNT1_SECRET");
  if (!account2Key) missingVars.push("BITFINEX_ACCOUNT2_KEY");
  if (!account2Secret) missingVars.push("BITFINEX_ACCOUNT2_SECRET");
  if (!telegramBotToken) missingVars.push("TELEGRAM_BOT_TOKEN");
  if (!telegramChatId) missingVars.push("TELEGRAM_CHAT_ID");
  if (missingVars.length > 0) {
    const errMsg = `\u7F3A\u5C11\u5FC5\u8981\u74B0\u5883\u8B8A\u6578: ${missingVars.join(", ")}`;
    console.error(`[CronJob] ${errMsg}`);
    return { success: false, error: errMsg };
  }
  console.log("[CronJob] \u4E26\u884C\u67E5\u8A62\u5169\u500B\u5E33\u6236\u5229\u606F...");
  const accounts = [
    { key: account1Key, secret: account1Secret, name: account1Name },
    { key: account2Key, secret: account2Secret, name: account2Name }
  ];
  const results = await fetchAllAccountsInterest(accounts);
  for (const result of results) {
    if (result.error) {
      console.error(`[CronJob] ${result.accountName} \u67E5\u8A62\u5931\u6557: ${result.error}`);
    } else {
      console.log(`[CronJob] ${result.accountName}: ${result.totalInterest.toFixed(8)} USD (${result.entries} \u7B46)`);
    }
  }
  const executedAt = /* @__PURE__ */ new Date();
  const message = formatInterestReport(results, executedAt);
  console.log("[CronJob] \u767C\u9001 Telegram \u901A\u77E5...");
  const telegramResult = await sendTelegramMessage(telegramBotToken, telegramChatId, message);
  const elapsed = ((Date.now() - startTime) / 1e3).toFixed(2);
  const mappedResults = results.map((r) => ({
    account: r.accountName,
    interest: r.totalInterest,
    entries: r.entries,
    error: r.error
  }));
  if (telegramResult.success) {
    console.log(`[CronJob] \u2705 \u5B8C\u6210 (\u8017\u6642 ${elapsed}s)`);
    return { success: true, elapsed: `${elapsed}s`, results: mappedResults };
  } else {
    console.error(`[CronJob] \u274C Telegram \u767C\u9001\u5931\u6557: ${telegramResult.error}`);
    return { success: false, error: `Telegram \u767C\u9001\u5931\u6557: ${telegramResult.error}`, results: mappedResults };
  }
}

// server/cron-vercel-entry.ts
async function handler(req, res) {
  const authHeader = req.headers["authorization"];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const result = await runDailyReport();
    if (result.success) {
      return res.status(200).json(result);
    } else {
      return res.status(500).json(result);
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ success: false, error: errorMsg });
  }
}
export {
  handler as default
};
