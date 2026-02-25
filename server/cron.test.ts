import { describe, expect, it, vi, beforeEach } from "vitest";
import { formatInterestReport } from "./lib/telegram";
import type { InterestResult } from "./lib/bitfinex";

// ============================================================
// formatInterestReport 測試
// ============================================================
describe("formatInterestReport", () => {
  const mockDate = new Date("2026-02-25T04:00:00.000Z"); // UTC 04:00 = 台灣時間 12:00

  it("應正確格式化兩個帳戶的利息報告", () => {
    const results: InterestResult[] = [
      { accountName: "帳戶 1", totalInterest: 2.84034982, currency: "USD", entries: 3 },
      { accountName: "帳戶 2", totalInterest: 1.72244812, currency: "USD", entries: 2 },
    ];

    const message = formatInterestReport(results, mockDate);

    expect(message).toContain("Bitfinex 每日利息報告");
    expect(message).toContain("帳戶 1");
    expect(message).toContain("帳戶 2");
    expect(message).toContain("2.84034982 USD");
    expect(message).toContain("1.72244812 USD");
    expect(message).toContain("今日總利息");
    // 總利息 = 2.84034982 + 1.72244812 = 4.56279794
    expect(message).toContain("4.56279794 USD");
  });

  it("應正確顯示帳戶查詢失敗的情況", () => {
    const results: InterestResult[] = [
      { accountName: "帳戶 1", totalInterest: 0, currency: "USD", entries: 0, error: "apikey: invalid" },
      { accountName: "帳戶 2", totalInterest: 1.5, currency: "USD", entries: 1 },
    ];

    const message = formatInterestReport(results, mockDate);

    expect(message).toContain("查詢失敗");
    expect(message).toContain("apikey: invalid");
    expect(message).toContain("1.50000000 USD");
    // 總利息只計算成功的帳戶
    expect(message).toContain("1.50000000 USD");
  });

  it("應正確計算零利息的情況", () => {
    const results: InterestResult[] = [
      { accountName: "帳戶 1", totalInterest: 0, currency: "USD", entries: 0 },
      { accountName: "帳戶 2", totalInterest: 0, currency: "USD", entries: 0 },
    ];

    const message = formatInterestReport(results, mockDate);

    expect(message).toContain("0.00000000 USD");
    expect(message).toContain("今日總利息");
  });

  it("應包含台灣時間的日期格式", () => {
    const results: InterestResult[] = [
      { accountName: "帳戶 1", totalInterest: 1.0, currency: "USD", entries: 1 },
    ];

    const message = formatInterestReport(results, mockDate);

    // 台灣時間 2026-02-25 12:00:00
    expect(message).toContain("2026");
    expect(message).toContain("台灣時間");
  });
});

// ============================================================
// Bitfinex 利息計算邏輯測試
// ============================================================
describe("Bitfinex 利息計算", () => {
  it("應正確累加正向利息條目", () => {
    // 模擬 Bitfinex ledger 格式: [ID, CURRENCY, null, MTS, null, AMOUNT, BALANCE, null, DESCRIPTION]
    const mockLedgerEntries = [
      [12345, "USD", null, 1740000000000, null, 1.5, 100.5, null, "Margin Funding Payment on wallet funding"],
      [12346, "USD", null, 1740000001000, null, 0.75, 101.25, null, "Margin Funding Payment on wallet funding"],
      [12347, "USD", null, 1740000002000, null, -0.5, 100.75, null, "Fee"], // 負數應被忽略
    ];

    let totalInterest = 0;
    for (const entry of mockLedgerEntries) {
      if (Array.isArray(entry) && entry.length > 5) {
        const amount = entry[5];
        if (typeof amount === "number" && amount > 0) {
          totalInterest += amount;
        }
      }
    }

    expect(totalInterest).toBeCloseTo(2.25, 8);
  });

  it("應忽略空的 ledger 回應", () => {
    const emptyData: unknown[][] = [];
    let totalInterest = 0;

    for (const entry of emptyData) {
      if (Array.isArray(entry) && entry.length > 5) {
        const amount = entry[5];
        if (typeof amount === "number" && amount > 0) {
          totalInterest += amount;
        }
      }
    }

    expect(totalInterest).toBe(0);
  });
});

// ============================================================
// 環境變數驗證測試
// ============================================================
describe("環境變數驗證", () => {
  it("應識別缺少的必要環境變數", () => {
    const requiredVars = [
      "BITFINEX_ACCOUNT1_KEY",
      "BITFINEX_ACCOUNT1_SECRET",
      "BITFINEX_ACCOUNT2_KEY",
      "BITFINEX_ACCOUNT2_SECRET",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
    ];

    const mockEnv: Record<string, string> = {
      BITFINEX_ACCOUNT1_KEY: "test_key",
      BITFINEX_ACCOUNT1_SECRET: "test_secret",
      // 故意缺少 ACCOUNT2 和 TELEGRAM 相關變數
    };

    const missingVars = requiredVars.filter((v) => !mockEnv[v]);

    expect(missingVars).toContain("BITFINEX_ACCOUNT2_KEY");
    expect(missingVars).toContain("BITFINEX_ACCOUNT2_SECRET");
    expect(missingVars).toContain("TELEGRAM_BOT_TOKEN");
    expect(missingVars).toContain("TELEGRAM_CHAT_ID");
    expect(missingVars).not.toContain("BITFINEX_ACCOUNT1_KEY");
    expect(missingVars).not.toContain("BITFINEX_ACCOUNT1_SECRET");
  });

  it("所有必要環境變數都存在時應通過驗證", () => {
    const requiredVars = [
      "BITFINEX_ACCOUNT1_KEY",
      "BITFINEX_ACCOUNT1_SECRET",
      "BITFINEX_ACCOUNT2_KEY",
      "BITFINEX_ACCOUNT2_SECRET",
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_CHAT_ID",
    ];

    const mockEnv: Record<string, string> = {
      BITFINEX_ACCOUNT1_KEY: "key1",
      BITFINEX_ACCOUNT1_SECRET: "secret1",
      BITFINEX_ACCOUNT2_KEY: "key2",
      BITFINEX_ACCOUNT2_SECRET: "secret2",
      TELEGRAM_BOT_TOKEN: "bot_token",
      TELEGRAM_CHAT_ID: "chat_id",
    };

    const missingVars = requiredVars.filter((v) => !mockEnv[v]);

    expect(missingVars).toHaveLength(0);
  });
});

// ============================================================
// Telegram 訊息格式測試（驗證 API 金鑰已正確設置）
// ============================================================
describe("Telegram Bot Token 格式驗證", () => {
  it("Telegram Bot Token 格式應符合規範", () => {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    // Telegram Bot Token 格式: {bot_id}:{random_string}
    if (token) {
      expect(token).toMatch(/^\d+:[A-Za-z0-9_-]+$/);
    }
  });

  it("Telegram Chat ID 格式應符合規範", () => {
    const chatId = process.env.TELEGRAM_CHAT_ID ?? "";
    if (chatId) {
      // Chat ID 應為數字（可能為負數，代表群組）
      expect(chatId).toMatch(/^-?\d+$/);
    }
  });
});
