import type { InterestResult } from "./bitfinex";

/**
 * 格式化每日利息報告訊息
 */
export function formatInterestReport(results: InterestResult[], executedAt: Date): string {
  const dateStr = executedAt.toLocaleString("zh-TW", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const totalInterest = results.reduce((sum, r) => sum + r.totalInterest, 0);

  let message = `📊 <b>Bitfinex 每日利息報告</b>\n`;
  message += `<i>${dateStr} (台灣時間)</i>\n\n`;

  for (const result of results) {
    if (result.error) {
      message += `<b>${result.accountName}:</b>\n`;
      message += `❌ 查詢失敗: ${result.error}\n\n`;
    } else {
      message += `<b>${result.accountName}:</b>\n`;
      message += `💰 ${result.totalInterest.toFixed(8)} ${result.currency}`;
      message += result.entries > 0 ? ` (${result.entries} 筆)\n\n` : `\n\n`;
    }
  }

  message += `━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
  message += `<b>今日總利息:</b>\n`;
  message += `🎯 <b>${totalInterest.toFixed(8)} USD</b>`;

  return message;
}

/**
 * 透過 Telegram Bot API 發送訊息，支援重試
 */
export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  retries = 3
): Promise<{ success: boolean; error?: string }> {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
        }),
      });

      const data = await res.json() as { ok: boolean; description?: string };

      if (data.ok) {
        return { success: true };
      }

      const errMsg = data.description ?? "Unknown Telegram error";
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 1000);
        continue;
      }
      return { success: false, error: errMsg };
    } catch (err) {
      if (attempt < retries) {
        await sleep(Math.pow(2, attempt) * 1000);
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return { success: false, error: errorMsg };
      }
    }
  }

  return { success: false, error: "Max retries exceeded" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
