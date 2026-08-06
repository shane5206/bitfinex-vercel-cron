# Bitfinex 放貸機器人設定指南

自動把 funding 錢包的閒置資金以 ladder（分層報價）方式掛單出借，取代單純掛 FRR。

## 運作方式

每次執行會依序做這幾件事：

1. 讀取當前 FRR（公開端點，不需簽名）
2. 讀取 funding 錢包的**可動用餘額**
3. 讀取尚未成交的掛單（已借出的資金屬於 credits，無法撤銷，也不會被動到）
4. 以「可動用餘額 + 未成交掛單」為可佈署資金，算出 ladder 報價
5. 若現有掛單已在容忍範圍內 → **不動作**（避免無意義撤單造成資金空窗）
6. 否則撤銷舊掛單、送出新掛單
7. 視設定發送 Telegram 摘要

## 安全設計

| 機制 | 說明 |
| --- | --- |
| 預設關閉 | 未設 `FUNDING_BOT_ENABLED=true` 完全不執行 |
| 預設 dry-run | 即使啟用，預設只計算與記錄，**不會真的下單** |
| 絕對利率下限 | 低於 `FUNDING_BOT_MIN_RATE_APY` 絕不掛單 |
| 相對利率下限 | 絕不低於 `FRR × FUNDING_BOT_FRR_FLOOR_MULT` |
| 下限向上取整 | 報價四捨五入後仍不會跌破下限 |
| FRR 異常保護 | FRR 非正數或 NaN 時不掛任何單 |
| 端點強制驗證 | 未設 `CRON_SECRET` 時端點直接停用 |
| 序列化請求 | 同一把 key 的請求依序送出，避免 `nonce: small` |

## 一、建立專用 API 金鑰（重要）

到 Bitfinex → API Keys 新建一把金鑰，**只開這些權限**：

- ✅ Margin Funding — Read & Write
- ✅ Wallets — Read
- ❌ **Withdraw — 一定要關閉**
- ❌ Orders / Trading — 不需要

這樣即使金鑰外洩，對方也無法把幣提走。

## 二、設定環境變數

在 Vercel → Settings → Environment Variables 新增：

### 必要

| 變數 | 說明 |
| --- | --- |
| `FUNDING_BOT_ACCOUNTS` | 要操作的帳戶編號，逗號分隔。單帳戶填 `1`，兩個帳戶填 `1,2`（預設 `1`） |
| `FUNDING_BOT_ACCOUNT1_KEY` | 帳戶 1 的專用金鑰 |
| `FUNDING_BOT_ACCOUNT1_SECRET` | 帳戶 1 的 secret |
| `FUNDING_BOT_ACCOUNT2_KEY` | 帳戶 2 的專用金鑰（只有一個帳戶就不用設） |
| `FUNDING_BOT_ACCOUNT2_SECRET` | 帳戶 2 的 secret |
| `CRON_SECRET` | 端點驗證用；**未設定機器人會拒絕執行** |

金鑰查找順序（由專用到通用），第一個找得到的就會被採用：

1. `FUNDING_BOT_ACCOUNT{N}_KEY` / `_SECRET` ← **建議**，只開放貸權限
2. `FUNDING_BOT_API_KEY` / `_SECRET`（僅帳戶 1，向下相容單帳戶設定）
3. `BITFINEX_ACCOUNT{N}_KEY` / `_SECRET`（沿用每日報告的金鑰，可能是唯讀而無法下單）

帳戶名稱沿用每日報告的 `BITFINEX_ACCOUNT{N}_NAME`，未設定時顯示為「帳戶 N」。

> 兩個帳戶請務必使用**各自不同**的 API 金鑰。若偵測到重複金鑰，重複的帳戶會被自動略過，
> 以免同一把 key 被併發操作而觸發 `nonce: small`。

### 開關

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `FUNDING_BOT_ENABLED` | `false` | 設 `true` 才會執行 |
| `FUNDING_BOT_DRY_RUN` | `true` | 設 `false` 才會真的下單 |

### 策略（皆可選，預設為「平衡」）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `FUNDING_BOT_CURRENCIES` | `USD` | 逗號分隔，例如 `USD,USDT` |
| `FUNDING_BOT_LADDER` | `80:1.0,20:1.15` | `權重:FRR倍數`，格式錯誤會回退預設。**不建議調高倍數**，理由見下方市場實測 |
| `FUNDING_BOT_MIN_RATE_APY` | `6` | 絕對下限（年化 %） |
| `FUNDING_BOT_FRR_FLOOR_MULT` | `0.8` | 相對下限倍數 |
| `FUNDING_BOT_PERIOD_DAYS` | `2` | 平時出借天期 |
| `FUNDING_BOT_SPIKE_APY` | `25` | FRR 年化超過此值視為 spike |
| `FUNDING_BOT_SPIKE_PERIOD` | `30` | spike 時改用的天期（鎖住高利） |
| `FUNDING_BOT_MIN_OFFER` | `150` | 單筆最小金額。Bitfinex 規定單筆放貸最低 150 USD 等值，低於此值會被拒單，不建議調低 |
| `FUNDING_BOT_MAX_OFFERS` | `5` | 一次最多掛幾筆 |
| `FUNDING_BOT_NOTIFY` | `changes` | `changes` / `always` / `never` |

## 三、設定外部排程

Vercel Hobby 的內建 cron 一天只會觸發一次，所以改用外部服務呼叫（一般 HTTP 呼叫不受此限）。

到 [cron-job.org](https://cron-job.org)（免費）建立工作：

- **URL**：`https://<你的網域>/api/funding-bot`
- **間隔**：每 15 分鐘
- **標頭**：`Authorization: Bearer <CRON_SECRET>`

若該服務不支援自訂標頭，可改用 `https://<你的網域>/api/funding-bot?secret=<CRON_SECRET>`
（較不建議，密鑰會出現在 URL 與日誌中）。

## 四、建議的上線步驟

1. **先 dry-run**：`FUNDING_BOT_ENABLED=true`、`FUNDING_BOT_DRY_RUN=true`
2. 手動呼叫端點一次，檢查回傳的 `planned` 報價是否合理：
   ```bash
   curl -H "Authorization: Bearer <CRON_SECRET>" https://<你的網域>/api/funding-bot
   ```
   回傳的 `accounts` 陣列每個帳戶一筆，各自包含 `currencies`。逐一確認
   `frrApy` 與 App 顯示的 FRR 相符、`deployable` 等於該帳戶的閒置資金。
3. 確認無誤後把 `FUNDING_BOT_DRY_RUN` 改成 `false`。
4. 前幾天用 `FUNDING_BOT_NOTIFY=always` 觀察每次動作，穩定後改回 `changes`。

## 為什麼預設不往上加價？（2026-08 市場實測）

實際抓取 fUSD 掛單簿與市場統計後的結論：

| 觀測 | 數值 |
| --- | --- |
| 掛單簿最高借款出價 | 約 **10.25% APY**（120 天期） |
| 同時間 FRR | 約 **12.35% APY** |
| 市場資金利用率 | **99.8%** |
| 借款需求 vs 固定利率放貸供給 | 約 $31.5M vs $42K |

關鍵推論：**FRR 已經高於掛單簿上所有借款出價**，因此任何「FRR × 1.3」之類的報價
都沒有對手方，掛上去只會 100% 閒置賺 0。實測也顯示帳戶約有 19% 資金空轉，
換算損失約 2.4 個百分點——遠大於調價可能帶來的收益。

因此預設策略以**資金利用率**為優先：主力貼著 FRR 確保成交，只留 20% 小幅加價捕捉突發行情。
機器人的價值在於「每 15 分鐘檢查、資金一回來立刻掛出去」，而不是聰明定價。

> 掛單簿格式為 `[利率, 天期, 筆數, 金額]`；金額為負代表借款需求（bid），為正代表放貸供給（ask）。

## 為什麼有時候完全不掛單？

Bitfinex 規定**單筆放貸最低 150 USD 等值**，因此可佈署資金低於 150 時機器人不會產生任何報價，
回傳會顯示 `可佈署資金不足或 FRR 異常，未產生報價`。這是正常行為，不是錯誤。

另外要注意：**已借出的資金（credits）在到期前無法調整**，機器人只能處理閒置資金與未成交掛單。
若現有放貸單開著**自動續期（auto-renew）**，到期後會自動以 FRR 重新借出，
資金永遠不會回到閒置狀態，機器人也就永遠接手不到——想讓機器人接管請先關閉自動續期。

## 已知限制

- 報價僅依 FRR 推算，尚未讀取 funding order book 深度。若要更貼近實際清算價，
  後續可加入 book 分析（目前刻意不做，因為未經實盤驗證的邏輯風險較高）。
- 已借出的資金（credits）在到期前無法調整利率，機器人只能處理閒置資金與未成交掛單。
- 報價偏高時可能有資金閒置，閒置期間為零收益；`FUNDING_BOT_LADDER` 可依實測調整。
