# Bitfinex Daily Interest Report - Vercel Cron

## 功能需求

- [x] 建立 Vercel Cron API 端點 (`/api/cron/daily-report`)
- [x] 整合 Bitfinex API 查詢借貸利息（過去 24 小時，category=28）
- [x] 並行查詢兩個帳戶以提高效率
- [x] 整合 Telegram Bot API 發送格式化報告
- [x] 實現錯誤處理與自動重試機制（最多 3 次）
- [x] 配置 vercel.json 設定 Cron 排程（台灣時間 12:00 = UTC 04:00）
- [x] 設置環境變數（API Keys、Telegram Token）
- [x] 建立 Dashboard 頁面顯示最近執行記錄
- [x] 撰寫 Vitest 測試覆蓋核心邏輯
- [x] 提供完整部署指南文件

## 緊急修正

- [x] 修正 Vercel 部署問題：原始碼外洩（建立 api/index.ts 導出 Express app，更新 vercel.json 使用 rewrites）
- [x] 確認 API 端點在 Vercel 上正常運作
- [x] 確認 Cron Job 設定正確

## 緊急修正 v2

- [x] 從根本重構項目架構以符合 Vercel 部署規範（修復 build 腳本，編譯 api/index.ts 到 api/index.js）
- [x] 修正 build 腳本並推送至 GitHub
