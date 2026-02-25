import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Clock, TrendingUp, Send, CheckCircle, AlertCircle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/lib/trpc";

export default function Home() {
  const [lastResult, setLastResult] = useState<{
    success: boolean;
    elapsed?: string;
    results?: { account: string; interest: number; entries: number; error?: string }[];
    error?: string;
  } | null>(null);

  const triggerMutation = trpc.cron.triggerReport.useMutation({
    onSuccess: (data) => {
      setLastResult(data);
      if (data.success) {
        toast.success("每日利息報告已成功發送到 Telegram！");
      } else {
        toast.error(`發送失敗：${data.error}`);
      }
    },
    onError: (err) => {
      toast.error(`請求失敗：${err.message}`);
    },
  });

  const isTriggering = triggerMutation.isPending;
  const handleTriggerReport = () => triggerMutation.mutate();

  const totalInterest = lastResult?.results?.reduce((sum, r) => sum + (r.interest ?? 0), 0) ?? 0;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-green-400" />
            </div>
            <div>
              <h1 className="text-base font-semibold text-white">Bitfinex 利息報告</h1>
              <p className="text-xs text-gray-400">每日自動通知系統</p>
            </div>
          </div>
          <Badge variant="outline" className="border-green-500/30 text-green-400 bg-green-500/10 text-xs">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 mr-1.5 animate-pulse inline-block" />
            運行中
          </Badge>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-6">
        {/* 統計卡片 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-blue-500/20 flex items-center justify-center flex-shrink-0">
                  <Clock className="w-4 h-4 text-blue-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-400">排程時間</p>
                  <p className="text-sm font-semibold text-white">每天 12:00</p>
                  <p className="text-xs text-gray-500">台灣時間 (UTC+8)</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-purple-500/20 flex items-center justify-center flex-shrink-0">
                  <TrendingUp className="w-4 h-4 text-purple-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-400">查詢帳戶</p>
                  <p className="text-sm font-semibold text-white">2 個帳戶</p>
                  <p className="text-xs text-gray-500">並行查詢，過去 24 小時</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="bg-gray-900 border-gray-800">
            <CardContent className="pt-5">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                  <Send className="w-4 h-4 text-green-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-400">通知方式</p>
                  <p className="text-sm font-semibold text-white">Telegram Bot</p>
                  <p className="text-xs text-gray-500">HTML 格式報告</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 手動觸發 */}
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-white">手動觸發報告</CardTitle>
            <CardDescription className="text-gray-400 text-sm">
              立即執行一次利息查詢並發送 Telegram 通知（用於測試或補發）
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={handleTriggerReport}
              disabled={isTriggering}
              className="bg-green-600 hover:bg-green-500 text-white"
            >
              {isTriggering ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  查詢中...
                </>
              ) : (
                <>
                  <RefreshCw className="w-4 h-4 mr-2" />
                  立即執行
                </>
              )}
            </Button>
          </CardContent>
        </Card>

        {/* 最近執行結果 */}
        {lastResult && (
          <Card className="bg-gray-900 border-gray-800">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-2">
                {lastResult.success ? (
                  <CheckCircle className="w-4 h-4 text-green-400" />
                ) : (
                  <AlertCircle className="w-4 h-4 text-red-400" />
                )}
                <CardTitle className="text-base text-white">
                  {lastResult.success ? "執行成功" : "執行失敗"}
                </CardTitle>
                {lastResult.elapsed && (
                  <Badge variant="outline" className="ml-auto border-gray-700 text-gray-400 text-xs">
                    耗時 {lastResult.elapsed}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {lastResult.error && (
                <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
                  {lastResult.error}
                </div>
              )}

              {lastResult.results && lastResult.results.length > 0 && (
                <div className="space-y-2">
                  {lastResult.results.map((r, i) => (
                    <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50">
                      <div>
                        <p className="text-sm font-medium text-white">{r.account}</p>
                        {r.error ? (
                          <p className="text-xs text-red-400 mt-0.5">{r.error}</p>
                        ) : (
                          <p className="text-xs text-gray-400 mt-0.5">{r.entries} 筆利息記錄</p>
                        )}
                      </div>
                      <div className="text-right">
                        {r.error ? (
                          <Badge variant="outline" className="border-red-500/30 text-red-400 bg-red-500/10 text-xs">
                            失敗
                          </Badge>
                        ) : (
                          <p className="text-sm font-mono font-semibold text-green-400">
                            +{r.interest.toFixed(8)} USD
                          </p>
                        )}
                      </div>
                    </div>
                  ))}

                  <Separator className="bg-gray-800 my-2" />

                  <div className="flex items-center justify-between px-3 py-2">
                    <p className="text-sm font-semibold text-white">今日總利息</p>
                    <p className="text-base font-mono font-bold text-green-400">
                      +{totalInterest.toFixed(8)} USD
                    </p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* 部署說明 */}
        <Card className="bg-gray-900 border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-white">Vercel 部署說明</CardTitle>
            <CardDescription className="text-gray-400 text-sm">
              部署到 Vercel 後，Cron Job 將自動每天台灣時間 12:00 執行
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-3">
              {[
                { step: "1", title: "匯出代碼到 GitHub", desc: "點擊右上角 Settings > GitHub，將代碼匯出到您的 GitHub 倉庫" },
                { step: "2", title: "連接 Vercel", desc: "登錄 vercel.com，點擊 New Project，選擇您的 GitHub 倉庫" },
                { step: "3", title: "設定環境變數", desc: "在 Vercel Dashboard > Settings > Environment Variables 中添加所有必要的環境變數" },
                { step: "4", title: "部署完成", desc: "Vercel 會自動讀取 vercel.json 中的 Cron 配置，每天 UTC 04:00 (台灣時間 12:00) 自動執行" },
              ].map((item) => (
                <div key={item.step} className="flex gap-3">
                  <div className="w-6 h-6 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <span className="text-xs font-bold text-blue-400">{item.step}</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-white">{item.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            <Separator className="bg-gray-800" />

            <div>
              <p className="text-xs font-semibold text-gray-300 mb-2">必要環境變數</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                {[
                  "BITFINEX_ACCOUNT1_KEY",
                  "BITFINEX_ACCOUNT1_SECRET",
                  "BITFINEX_ACCOUNT2_KEY",
                  "BITFINEX_ACCOUNT2_SECRET",
                  "TELEGRAM_BOT_TOKEN",
                  "TELEGRAM_CHAT_ID",
                  "CRON_SECRET",
                ].map((v) => (
                  <code key={v} className="text-xs bg-gray-800 text-green-400 px-2 py-1 rounded font-mono">
                    {v}
                  </code>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
