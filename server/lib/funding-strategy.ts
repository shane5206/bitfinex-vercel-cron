/**
 * 放貸報價策略（純函式，無副作用，方便完整測試）
 *
 * 利率單位說明：
 * - Bitfinex API 的 funding rate 一律是「每日利率的小數」，例如 0.00033873 = 每日 0.033873%。
 * - App 介面顯示的是百分比（0.033873 %），也就是 API 值 × 100。
 * - 本檔以 APY(%) 表示年化，換算採單利：APY = 每日利率 × 365 × 100。
 */

/** ladder 的其中一層 */
export interface LadderTier {
  /** 此層佔可佈署資金的權重（相對值，慣用百分比） */
  pct: number;
  /** 報價相對 FRR 的倍數，1.0 代表等於 FRR */
  mult: number;
}

export interface StrategyConfig {
  tiers: LadderTier[];
  /** 絕對利率下限（年化 %）：無論如何都不會用低於此價掛單 */
  minRateApy: number;
  /** 相對利率下限：不會低於 FRR × 此倍數 */
  frrFloorMult: number;
  /** 平時的出借天期 */
  basePeriodDays: number;
  /** FRR 年化達到此值視為 spike，改掛長天期鎖住高利 */
  spikeApy: number;
  /** spike 時使用的出借天期 */
  spikePeriodDays: number;
  /** 單筆最小出借金額（低於此值 Bitfinex 會拒單） */
  minOfferAmount: number;
  /** 一次最多掛幾筆 */
  maxOffers: number;
}

/** 策略算出來、預期要掛的單 */
export interface DesiredOffer {
  amount: number;
  /** 每日利率小數，可直接送進 API */
  rate: number;
  period: number;
  mult: number;
}

/** 帳戶上目前尚未成交的掛單 */
export interface ExistingOffer {
  id: number;
  amount: number;
  rate: number;
  period: number;
}

/**
 * Bitfinex 單筆放貸的最低金額：150 USD 或等值。
 * 低於此值送出會被 API 拒絕。
 * 來源：https://support.bitfinex.com/hc/en-us/articles/213918949-What-is-the-minimum-offer-for-Funding
 */
export const BITFINEX_MIN_FUNDING_OFFER = 150;

/**
 * 預設 ladder：以「資金利用率」為優先，而非往上要高價。
 *
 * 依據 2026-08 實測的 fUSD 掛單簿：整本書最高的借款出價僅約 10.25% APY，
 * 而同時間 FRR 為 12.35%。也就是說任何高於 FRR 的報價都沒有對手方，
 * 掛上去必然閒置賺 0。實測亦顯示約 19% 資金空轉造成約 2.4 個百分點的損失，
 * 遠大於調價可能帶來的收益，因此主力貼著 FRR，僅保留小部分捕捉突發行情。
 */
export const DEFAULT_LADDER: LadderTier[] = [
  { pct: 80, mult: 1.0 },
  { pct: 20, mult: 1.15 },
];

/** 年化 %（單利）換算成每日利率小數 */
export function apyToDailyRate(apy: number): number {
  return apy / 100 / 365;
}

/** 每日利率小數換算成年化 %（單利） */
export function dailyRateToApy(daily: number): number {
  return daily * 365 * 100;
}

function floorTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.floor(value * f) / f;
}

function roundTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
}

function ceilTo(value: number, decimals: number): number {
  const f = Math.pow(10, decimals);
  return Math.ceil(value * f) / f;
}

/**
 * 解析 ladder 設定字串，格式為 "權重:倍數" 以逗號分隔，例如 "30:1.0,40:1.3,30:1.8"。
 * 任何一段無效就整組視為無效並回傳 null，讓呼叫端回退到預設值。
 */
export function parseLadder(input: string): LadderTier[] | null {
  const tiers: LadderTier[] = [];

  for (const part of input.split(",")) {
    const segment = part.trim();
    if (!segment) continue;

    const [rawPct, rawMult] = segment.split(":");
    const pct = Number(rawPct);
    const mult = Number(rawMult);

    if (!Number.isFinite(pct) || !Number.isFinite(mult) || pct <= 0 || mult <= 0) {
      return null;
    }
    tiers.push({ pct, mult });
  }

  return tiers.length > 0 ? tiers : null;
}

/**
 * 依可佈署資金與當前 FRR 算出想掛的 ladder。
 *
 * 安全性設計：
 * - FRR 異常（非正數/NaN）時回傳空陣列，寧可不掛單也不要用錯誤利率送出。
 * - 每一層都套用「絕對下限」與「FRR 相對下限」，避免把資金賤價出借。
 * - 金額低於最小出借單位的層級會被剔除，其資金按權重重新分配給其他層，避免資金閒置。
 */
export function planOffers(
  deployable: number,
  frrDaily: number,
  cfg: StrategyConfig
): DesiredOffer[] {
  if (!Number.isFinite(deployable) || !Number.isFinite(frrDaily)) return [];
  if (frrDaily <= 0) return [];
  if (deployable < cfg.minOfferAmount) return [];

  const period =
    dailyRateToApy(frrDaily) >= cfg.spikeApy ? cfg.spikePeriodDays : cfg.basePeriodDays;

  // 兩道利率下限取較高者。下限本身向上取整到 8 位小數，
  // 否則報價四捨五入後可能低於下限，讓「絕對下限」形同虛設。
  const floorRate = ceilTo(
    Math.max(apyToDailyRate(cfg.minRateApy), frrDaily * cfg.frrFloorMult),
    8
  );

  let tiers = cfg.tiers.filter((t) => t.pct > 0 && t.mult > 0).slice(0, cfg.maxOffers);
  if (tiers.length === 0) return [];

  // 逐步剔除金額過小的層級，剩餘資金按權重重新分配。
  // 剔除時優先拿掉「倍數最高」的層而非金額最小的層：資金不足時最該保住
  // 貼近 FRR、確定借得出去的那層，否則錢會全掛在高價空等而賺不到利息。
  while (tiers.length > 1) {
    const weight = tiers.reduce((sum, t) => sum + t.pct, 0);
    const amounts = tiers.map((t) => (deployable * t.pct) / weight);

    if (Math.min(...amounts) >= cfg.minOfferAmount) break;

    let dropIdx = 0;
    for (let i = 1; i < tiers.length; i++) {
      if (tiers[i].mult > tiers[dropIdx].mult) dropIdx = i;
    }
    tiers = tiers.filter((_, i) => i !== dropIdx);
  }

  const weight = tiers.reduce((sum, t) => sum + t.pct, 0);

  return tiers
    .map((t) => ({
      // 無條件捨去到小數 2 位，確保加總不會超過可用餘額
      amount: floorTo((deployable * t.pct) / weight, 2),
      rate: Math.max(roundTo(frrDaily * t.mult, 8), floorRate),
      period,
      mult: t.mult,
    }))
    .filter((o) => o.amount >= cfg.minOfferAmount);
}

/**
 * 判斷現有掛單是否需要撤單重掛。
 *
 * 目的是避免「每次執行都無意義地撤單重掛」：FRR 只有小幅波動時維持原狀，
 * 減少撤單到重掛之間資金閒置的空窗。
 */
export function needsRequote(
  existing: ExistingOffer[],
  desired: DesiredOffer[],
  rateTolerance = 0.05,
  amountTolerance = 0.1
): boolean {
  // 沒有想掛的單就不要動現有掛單（例如資金都已借出）
  if (desired.length === 0) return false;
  if (existing.length !== desired.length) return true;

  const e = [...existing].sort((a, b) => a.rate - b.rate);
  const d = [...desired].sort((a, b) => a.rate - b.rate);

  for (let i = 0; i < d.length; i++) {
    if (e[i].period !== d[i].period) return true;
    if (Math.abs(e[i].rate - d[i].rate) / d[i].rate > rateTolerance) return true;
    if (Math.abs(e[i].amount - d[i].amount) / Math.max(d[i].amount, 1) > amountTolerance) {
      return true;
    }
  }

  return false;
}
