/**
 * 放貸機器人的 Vercel Function 入口
 * 編譯到 api/funding-bot.js，由外部 cron 服務（如 cron-job.org）定時呼叫。
 *
 * 驗證方式（擇一）：
 * - 標頭 Authorization: Bearer {CRON_SECRET}（建議，密鑰不會出現在 URL 與日誌）
 * - 查詢字串 ?secret={CRON_SECRET}（給不支援自訂標頭的排程服務）
 *
 * 此端點會實際下單，因此未設定 CRON_SECRET 時一律拒絕執行，
 * 不允許像唯讀端點那樣在無密鑰時開放。
 */
import "dotenv/config";
import { runFundingBot } from "./cron/funding-bot";

export default async function handler(
  req: {
    headers: Record<string, string | undefined>;
    query?: Record<string, string | string[] | undefined>;
  },
  res: {
    status: (code: number) => { json: (data: unknown) => void };
    json: (data: unknown) => void;
  }
) {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[FundingBot] 未設定 CRON_SECRET，拒絕執行");
    return res.status(500).json({
      success: false,
      error: "伺服器未設定 CRON_SECRET，放貸端點已停用",
    });
  }

  const authHeader = req.headers["authorization"];
  const querySecret = typeof req.query?.secret === "string" ? req.query.secret : undefined;
  const authorized = authHeader === `Bearer ${cronSecret}` || querySecret === cronSecret;

  if (!authorized) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const result = await runFundingBot();
    return res.status(result.success ? 200 : 500).json(result);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error("[FundingBot] 執行失敗:", errorMsg);
    return res.status(500).json({ success: false, error: errorMsg });
  }
}
