/**
 * 獨立的 Vercel Cron Function 入口
 * 編譯到 api/cron/daily-report.js
 * Vercel Cron Job 直接呼叫此文件，不需要經過 rewrites
 */
import "dotenv/config";
import { runDailyReport } from "./cron/daily-report";

// Vercel Serverless Function handler
// Vercel 會注入 req/res，格式與 Node.js http 相同
export default async function handler(
  req: { headers: Record<string, string | undefined> },
  res: {
    status: (code: number) => { json: (data: unknown) => void };
    json: (data: unknown) => void;
  }
) {
  // Vercel Cron Job 會自動在請求頭加入 Authorization: Bearer {CRON_SECRET}
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
