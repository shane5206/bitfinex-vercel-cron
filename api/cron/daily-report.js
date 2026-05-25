// server/cron-vercel-entry.ts
import "dotenv/config";

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
async function fetchDailyInterest(apiKey, apiSecret, accountName, retries = 3) {
  const now = Date.now();
  const start = now - 24 * 60 * 60 * 1e3;
  const apiPath = "v2/auth/r/ledgers/hist";
  const bodyStr = JSON.stringify({ category: 28, limit: 2500, start, end: now });
  for (let attempt = 1; attempt <= retries; attempt++) {
    const nonce = nextNonce();
    const signaturePayload = `/api/${apiPath}${nonce}${bodyStr}`;
    const signature = crypto.createHmac("sha384", apiSecret).update(signaturePayload).digest("hex");
    const headers = {
      "bfx-nonce": nonce,
      "bfx-apikey": apiKey,
      "bfx-signature": signature,
      "Content-Type": "application/json"
    };
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
async function fetchFundingBalance(apiKey, apiSecret, retries = 3) {
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
      "Content-Type": "application/json"
    };
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
        if (attempt < retries) {
          await sleep(Math.pow(2, attempt) * 1e3);
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
        await sleep(Math.pow(2, attempt) * 1e3);
      } else {
        return 0;
      }
    }
  }
  return 0;
}
async function fetchAllAccountsInterest(accounts) {
  return Promise.all(
    accounts.map(async (acc) => {
      const interest = await fetchDailyInterest(acc.key, acc.secret, acc.name);
      const principal = await fetchFundingBalance(acc.key, acc.secret);
      return { ...interest, principal };
    })
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
async function sendTelegramMessage(botToken, chatId, text2, retries = 3) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: text2,
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

// server/db.ts
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";

// drizzle/schema.ts
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
var users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull()
});
var interestSnapshots = mysqlTable("interestSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  /** 快照日期 (UTC) */
  snapshotDate: timestamp("snapshotDate").notNull(),
  /** 帳戶名稱 (e.g., Account 1, Account 2) */
  accountName: varchar("accountName", { length: 64 }).notNull(),
  /** 該帳戶該日期的利息總額 (USD) */
  interestUsd: text("interestUsd").notNull(),
  /** 該帳戶該日期的利息筆數 */
  interestCount: int("interestCount").notNull(),
  /** 該帳戶該日期的 funding 錢包本金 (USD)，用於計算年化報酬率 */
  principalUsd: text("principalUsd"),
  /** 記錄建立時間 */
  createdAt: timestamp("createdAt").defaultNow().notNull()
});

// server/_core/env.ts
var ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? ""
};

// server/db.ts
import { gte, lt, desc, and } from "drizzle-orm";
var _db = null;
async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}
async function insertInterestSnapshot(snapshotDate, accountName, interestUsd, interestCount, principalUsd) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot insert interest snapshot: database not available");
    return;
  }
  const startOfDay = new Date(
    Date.UTC(snapshotDate.getUTCFullYear(), snapshotDate.getUTCMonth(), snapshotDate.getUTCDate())
  );
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1e3);
  try {
    const existing = await db.select({ id: interestSnapshots.id }).from(interestSnapshots).where(
      and(
        eq(interestSnapshots.accountName, accountName),
        gte(interestSnapshots.snapshotDate, startOfDay),
        lt(interestSnapshots.snapshotDate, endOfDay)
      )
    ).limit(1);
    if (existing.length > 0) {
      await db.update(interestSnapshots).set({ snapshotDate, interestUsd, interestCount, principalUsd }).where(eq(interestSnapshots.id, existing[0].id));
    } else {
      await db.insert(interestSnapshots).values({
        snapshotDate,
        accountName,
        interestUsd,
        interestCount,
        principalUsd
      });
    }
  } catch (error) {
    console.error("[Database] Failed to insert interest snapshot:", error);
  }
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
  await Promise.all(
    results.filter((r) => !r.error).map(
      (r) => insertInterestSnapshot(
        executedAt,
        r.accountName,
        r.totalInterest.toString(),
        r.entries,
        r.principal && r.principal > 0 ? r.principal.toString() : null
      )
    )
  );
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
