import { describe, expect, it } from "vitest";
import {
  DEFAULT_LADDER,
  apyToDailyRate,
  dailyRateToApy,
  needsRequote,
  parseLadder,
  planOffers,
  type DesiredOffer,
  type ExistingOffer,
  type StrategyConfig,
} from "./lib/funding-strategy";

const cfg: StrategyConfig = {
  tiers: DEFAULT_LADDER,
  minRateApy: 6,
  frrFloorMult: 0.8,
  basePeriodDays: 2,
  spikeApy: 25,
  spikePeriodDays: 30,
  minOfferAmount: 50,
  maxOffers: 5,
};

// 使用者實際數據：本金約 10,952 USD，FRR 每日 0.033873%
const REAL_FRR = 0.00033873;
const REAL_DEPLOYABLE = 10952.13;

describe("利率單位換算", () => {
  it("每日利率與年化應可互相換算", () => {
    // 使用者截圖的 FRR 0.033873%/日 ≈ 12.36% 年化
    expect(dailyRateToApy(REAL_FRR)).toBeCloseTo(12.36, 2);
    expect(apyToDailyRate(dailyRateToApy(REAL_FRR))).toBeCloseTo(REAL_FRR, 10);
  });

  it("年化 6% 應等於每日 0.00016438", () => {
    expect(apyToDailyRate(6)).toBeCloseTo(0.00016438, 8);
  });

  it("換算來回應保持一致", () => {
    expect(dailyRateToApy(apyToDailyRate(6))).toBeCloseTo(6, 10);
  });
});

describe("planOffers 基本 ladder", () => {
  it("應依 30/40/30 權重產生三筆掛單", () => {
    const offers = planOffers(REAL_DEPLOYABLE, REAL_FRR, cfg);

    expect(offers).toHaveLength(3);
    expect(offers[0].amount).toBeCloseTo(3285.63, 2);
    expect(offers[1].amount).toBeCloseTo(4380.85, 2);
    expect(offers[2].amount).toBeCloseTo(3285.63, 2);
  });

  it("報價應為 FRR 的 1.0 / 1.3 / 1.8 倍", () => {
    const offers = planOffers(REAL_DEPLOYABLE, REAL_FRR, cfg);

    expect(offers[0].rate).toBeCloseTo(REAL_FRR, 8);
    expect(offers[1].rate).toBeCloseTo(REAL_FRR * 1.3, 8);
    expect(offers[2].rate).toBeCloseTo(REAL_FRR * 1.8, 8);
  });

  it("掛單總額不得超過可佈署資金", () => {
    const offers = planOffers(REAL_DEPLOYABLE, REAL_FRR, cfg);
    const total = offers.reduce((sum, o) => sum + o.amount, 0);

    expect(total).toBeLessThanOrEqual(REAL_DEPLOYABLE);
    // 只因四捨五入而有極小差額
    expect(total).toBeGreaterThan(REAL_DEPLOYABLE - 1);
  });

  it("平時應使用基本天期", () => {
    const offers = planOffers(REAL_DEPLOYABLE, REAL_FRR, cfg);
    expect(offers.every((o) => o.period === 2)).toBe(true);
  });
});

describe("利率下限保護（避免賤價出借）", () => {
  it("FRR 極低時應套用絕對下限 minRateApy", () => {
    // 每日 0.00001 ≈ 年化 3.65%，低於 6% 下限
    const offers = planOffers(5000, 0.00001, cfg);

    expect(offers.length).toBeGreaterThan(0);
    for (const offer of offers) {
      expect(dailyRateToApy(offer.rate)).toBeGreaterThanOrEqual(6 - 1e-6);
    }
  });

  it("任何一筆掛單都不得低於 FRR × frrFloorMult", () => {
    const offers = planOffers(REAL_DEPLOYABLE, REAL_FRR, cfg);

    for (const offer of offers) {
      expect(offer.rate).toBeGreaterThanOrEqual(REAL_FRR * cfg.frrFloorMult);
    }
  });

  it("倍數低於 1 的 ladder 仍會被下限拉回", () => {
    const risky: StrategyConfig = { ...cfg, tiers: [{ pct: 100, mult: 0.1 }] };
    const offers = planOffers(5000, REAL_FRR, risky);

    expect(offers).toHaveLength(1);
    // 0.1 倍會被 FRR × 0.8 的相對下限擋住（下限向上取整，故不得低於它）
    expect(offers[0].rate).toBeGreaterThanOrEqual(REAL_FRR * 0.8);
    expect(offers[0].rate).toBeCloseTo(REAL_FRR * 0.8, 7);
  });
});

describe("異常輸入時不得掛單", () => {
  it.each([
    ["FRR 為 0", 0],
    ["FRR 為負", -0.0001],
    ["FRR 為 NaN", Number.NaN],
  ])("%s 應回傳空陣列", (_label, frr) => {
    expect(planOffers(REAL_DEPLOYABLE, frr, cfg)).toEqual([]);
  });

  it("可佈署資金低於最小出借金額應回傳空陣列", () => {
    expect(planOffers(40, REAL_FRR, cfg)).toEqual([]);
  });

  it("可佈署資金為 NaN 應回傳空陣列", () => {
    expect(planOffers(Number.NaN, REAL_FRR, cfg)).toEqual([]);
  });
});

describe("小額資金重新分配", () => {
  it("層級金額低於最小單位時應剔除並把資金分給其他層", () => {
    // 120 依 30/40/30 分配會是 36/48/36，三層都低於 50
    const offers = planOffers(120, REAL_FRR, cfg);

    expect(offers).toHaveLength(2);
    for (const offer of offers) {
      expect(offer.amount).toBeGreaterThanOrEqual(cfg.minOfferAmount);
    }
    expect(offers.reduce((s, o) => s + o.amount, 0)).toBeLessThanOrEqual(120);
  });

  it("資金只夠一筆時應全部集中成一筆，且掛在最容易成交的 FRR 價位", () => {
    const offers = planOffers(60, REAL_FRR, cfg);

    expect(offers).toHaveLength(1);
    expect(offers[0].amount).toBeCloseTo(60, 2);
    expect(offers[0].mult).toBe(1.0);
  });

  it("資金不足時應保留低倍數層、剔除高倍數層", () => {
    // 使用者帳戶 1 的實際情境：可佈署僅 136.35，三層各約 40/54/40 皆不足 50
    const offers = planOffers(136.35, REAL_FRR, cfg);

    expect(offers).toHaveLength(2);
    // 應留下 1.0 與 1.3 倍，而不是把最容易成交的 FRR 層丟掉
    expect(offers.map((o) => o.mult)).toEqual([1.0, 1.3]);
    expect(offers[0].rate).toBeCloseTo(REAL_FRR, 8);
  });
});

describe("利率 spike 時改掛長天期", () => {
  it("FRR 年化超過門檻應改用 spike 天期", () => {
    // 每日 0.0007 ≈ 年化 25.55%，超過 25% 門檻
    const offers = planOffers(REAL_DEPLOYABLE, 0.0007, cfg);

    expect(offers.length).toBeGreaterThan(0);
    expect(offers.every((o) => o.period === 30)).toBe(true);
  });

  it("未達門檻仍使用基本天期", () => {
    const offers = planOffers(REAL_DEPLOYABLE, 0.0006, cfg);
    expect(offers.every((o) => o.period === 2)).toBe(true);
  });
});

describe("needsRequote 判斷是否重掛", () => {
  const desired: DesiredOffer[] = [
    { amount: 1000, rate: 0.0003, period: 2, mult: 1 },
    { amount: 1000, rate: 0.0004, period: 2, mult: 1.3 },
  ];

  const matching: ExistingOffer[] = [
    { id: 1, amount: 1000, rate: 0.0003, period: 2 },
    { id: 2, amount: 1000, rate: 0.0004, period: 2 },
  ];

  it("完全相符時不應重掛", () => {
    expect(needsRequote(matching, desired)).toBe(false);
  });

  it("沒有想掛的單時不應動現有掛單", () => {
    expect(needsRequote(matching, [])).toBe(false);
  });

  it("掛單數量不同應重掛", () => {
    expect(needsRequote([matching[0]], desired)).toBe(true);
  });

  it("利率小幅波動（容忍範圍內）不應重掛", () => {
    const drifted = [
      { id: 1, amount: 1000, rate: 0.000306, period: 2 },
      { id: 2, amount: 1000, rate: 0.0004, period: 2 },
    ];
    expect(needsRequote(drifted, desired)).toBe(false);
  });

  it("利率大幅偏離應重掛", () => {
    const drifted = [
      { id: 1, amount: 1000, rate: 0.0002, period: 2 },
      { id: 2, amount: 1000, rate: 0.0004, period: 2 },
    ];
    expect(needsRequote(drifted, desired)).toBe(true);
  });

  it("天期不同應重掛", () => {
    const drifted = [
      { id: 1, amount: 1000, rate: 0.0003, period: 30 },
      { id: 2, amount: 1000, rate: 0.0004, period: 2 },
    ];
    expect(needsRequote(drifted, desired)).toBe(true);
  });

  it("金額大幅變動應重掛（例如部分成交後有新資金）", () => {
    const drifted = [
      { id: 1, amount: 1000, rate: 0.0003, period: 2 },
      { id: 2, amount: 2000, rate: 0.0004, period: 2 },
    ];
    expect(needsRequote(drifted, desired)).toBe(true);
  });
});

describe("parseLadder 設定字串解析", () => {
  it("應解析合法字串", () => {
    expect(parseLadder("30:1.0,40:1.3,30:1.8")).toEqual([
      { pct: 30, mult: 1.0 },
      { pct: 40, mult: 1.3 },
      { pct: 30, mult: 1.8 },
    ]);
  });

  it("應容忍多餘空白", () => {
    expect(parseLadder(" 50:1.0 , 50:1.5 ")).toEqual([
      { pct: 50, mult: 1.0 },
      { pct: 50, mult: 1.5 },
    ]);
  });

  it.each([
    ["缺少倍數", "30"],
    ["非數字", "abc:1.2"],
    ["負權重", "-10:1.2"],
    ["倍數為 0", "30:0"],
    ["空字串", ""],
  ])("%s 應回傳 null 以便回退預設值", (_label, input) => {
    expect(parseLadder(input)).toBeNull();
  });
});
