import type { Request, Response } from "express";
import { fetchAllAccountsInterest } from "../lib/bitfinex";
import { formatInterestReport, sendTelegramMessage } from "../lib/telegram";

/**
 * Vercel Cron Job Handler
 * 每天台灣時間 12:00 (UTC 04:00) 執行
 * 
 * 安全性：Vercel 會在請求頭中加入 Authorization: Bearer {CRON_SECRET}
 * 需在 vercel.json 中設定 CRON_SECRET 環境變數
 */
export async function dailyReportHandler(req: Request, res: Response): Promise<void> {
  // 驗證 Cron 請求（防止未授權調用）
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const startTime = Date.now();
  console.log(`[CronJob] 開始執行每日利息報告 - ${new Date().toISOString()}`);

  // 讀取環境變數
  const account1Key = process.env.BITFINEX_ACCOUNT1_KEY ?? "";
  const account1Secret = process.env.BITFINEX_ACCOUNT1_SECRET ?? "";
  const account1Name = process.env.BITFINEX_ACCOUNT1_NAME ?? "帳戶 1";

  const account2Key = process.env.BITFINEX_ACCOUNT2_KEY ?? "";
  const account2Secret = process.env.BITFINEX_ACCOUNT2_SECRET ?? "";
  const account2Name = process.env.BITFINEX_ACCOUNT2_NAME ?? "帳戶 2";

  const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const telegramChatId = process.env.TELEGRAM_CHAT_ID ?? "";

  // 驗證必要環境變數
  const missingVars: string[] = [];
  if (!account1Key) missingVars.push("BITFINEX_ACCOUNT1_KEY");
  if (!account1Secret) missingVars.push("BITFINEX_ACCOUNT1_SECRET");
  if (!account2Key) missingVars.push("BITFINEX_ACCOUNT2_KEY");
  if (!account2Secret) missingVars.push("BITFINEX_ACCOUNT2_SECRET");
  if (!telegramBotToken) missingVars.push("TELEGRAM_BOT_TOKEN");
  if (!telegramChatId) missingVars.push("TELEGRAM_CHAT_ID");

  if (missingVars.length > 0) {
    const errMsg = `缺少必要環境變數: ${missingVars.join(", ")}`;
    console.error(`[CronJob] ${errMsg}`);
    res.status(500).json({ error: errMsg });
    return;
  }

  // 並行查詢兩個帳戶的利息
  console.log("[CronJob] 並行查詢兩個帳戶利息...");
  const accounts = [
    { key: account1Key, secret: account1Secret, name: account1Name },
    { key: account2Key, secret: account2Secret, name: account2Name },
  ];

  const results = await fetchAllAccountsInterest(accounts);

  // 記錄查詢結果
  for (const result of results) {
    if (result.error) {
      console.error(`[CronJob] ${result.accountName} 查詢失敗: ${result.error}`);
    } else {
      console.log(`[CronJob] ${result.accountName}: ${result.totalInterest.toFixed(8)} USD (${result.entries} 筆)`);
    }
  }

  // 格式化並發送 Telegram 報告
  const executedAt = new Date();
  const message = formatInterestReport(results, executedAt);

  console.log("[CronJob] 發送 Telegram 通知...");
  const telegramResult = await sendTelegramMessage(telegramBotToken, telegramChatId, message);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

  if (telegramResult.success) {
    console.log(`[CronJob] ✅ 完成 (耗時 ${elapsed}s)`);
    res.status(200).json({
      success: true,
      elapsed: `${elapsed}s`,
      results: results.map((r) => ({
        account: r.accountName,
        interest: r.totalInterest,
        entries: r.entries,
        error: r.error,
      })),
    });
  } else {
    console.error(`[CronJob] ❌ Telegram 發送失敗: ${telegramResult.error}`);
    res.status(500).json({
      success: false,
      error: `Telegram 發送失敗: ${telegramResult.error}`,
      results: results.map((r) => ({
        account: r.accountName,
        interest: r.totalInterest,
        entries: r.entries,
        error: r.error,
      })),
    });
  }
}
