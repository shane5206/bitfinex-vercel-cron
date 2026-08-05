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
| `FUNDING_BOT_LADDER` | `30:1.0,40:1.3,30:1.8` | `權重:FRR倍數`，格式錯誤會回退預設 |
| `FUNDING_BOT_MIN_RATE_APY` | `6` | 絕對下限（年化 %） |
| `FUNDING_BOT_FRR_FLOOR_MULT` | `0.8` | 相對下限倍數 |
| `FUNDING_BOT_PERIOD_DAYS` | `2` | 平時出借天期 |
| `FUNDING_BOT_SPIKE_APY` | `25` | FRR 年化超過此值視為 spike |
| `FUNDING_BOT_SPIKE_PERIOD` | `30` | spike 時改用的天期（鎖住高利） |
| `FUNDING_BOT_MIN_OFFER` | `50` | 單筆最小金額，被拒單時調高 |
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

## 已知限制

- 報價僅依 FRR 推算，尚未讀取 funding order book 深度。若要更貼近實際清算價，
  後續可加入 book 分析（目前刻意不做，因為未經實盤驗證的邏輯風險較高）。
- 已借出的資金（credits）在到期前無法調整利率，機器人只能處理閒置資金與未成交掛單。
- 報價偏高時可能有資金閒置，閒置期間為零收益；`FUNDING_BOT_LADDER` 可依實測調整。
