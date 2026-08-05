import { describe, expect, it } from "vitest";
import { loadAccounts } from "./cron/funding-bot";

describe("loadAccounts 多帳戶解析", () => {
  it("預設只啟用帳戶 1", () => {
    const accounts = loadAccounts({
      BITFINEX_ACCOUNT1_KEY: "key1",
      BITFINEX_ACCOUNT1_SECRET: "secret1",
      BITFINEX_ACCOUNT2_KEY: "key2",
      BITFINEX_ACCOUNT2_SECRET: "secret2",
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0].key).toBe("key1");
  });

  it("設定 FUNDING_BOT_ACCOUNTS=1,2 應啟用兩個帳戶", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_ACCOUNTS: "1,2",
      BITFINEX_ACCOUNT1_KEY: "key1",
      BITFINEX_ACCOUNT1_SECRET: "secret1",
      BITFINEX_ACCOUNT2_KEY: "key2",
      BITFINEX_ACCOUNT2_SECRET: "secret2",
    });

    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.key)).toEqual(["key1", "key2"]);
  });

  it("專用放貸金鑰應優先於每日報告的金鑰", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_ACCOUNTS: "1",
      FUNDING_BOT_ACCOUNT1_KEY: "funding-key",
      FUNDING_BOT_ACCOUNT1_SECRET: "funding-secret",
      BITFINEX_ACCOUNT1_KEY: "readonly-key",
      BITFINEX_ACCOUNT1_SECRET: "readonly-secret",
    });

    expect(accounts[0].key).toBe("funding-key");
    expect(accounts[0].secret).toBe("funding-secret");
  });

  it("單帳戶舊設定 FUNDING_BOT_API_KEY 仍可運作", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_API_KEY: "legacy-key",
      FUNDING_BOT_API_SECRET: "legacy-secret",
      BITFINEX_ACCOUNT1_KEY: "readonly-key",
      BITFINEX_ACCOUNT1_SECRET: "readonly-secret",
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0].key).toBe("legacy-key");
  });

  it("舊的單帳戶設定不應套用到帳戶 2", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_ACCOUNTS: "2",
      FUNDING_BOT_API_KEY: "legacy-key",
      FUNDING_BOT_API_SECRET: "legacy-secret",
    });

    expect(accounts).toHaveLength(0);
  });

  it("應使用自訂帳戶名稱", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_ACCOUNTS: "1,2",
      BITFINEX_ACCOUNT1_NAME: "主帳戶",
      BITFINEX_ACCOUNT1_KEY: "key1",
      BITFINEX_ACCOUNT1_SECRET: "secret1",
      BITFINEX_ACCOUNT2_KEY: "key2",
      BITFINEX_ACCOUNT2_SECRET: "secret2",
    });

    expect(accounts[0].name).toBe("主帳戶");
    expect(accounts[1].name).toBe("帳戶 2");
  });

  it("缺少 secret 的帳戶應被略過", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_ACCOUNTS: "1,2",
      BITFINEX_ACCOUNT1_KEY: "key1",
      BITFINEX_ACCOUNT1_SECRET: "secret1",
      BITFINEX_ACCOUNT2_KEY: "key2",
    });

    expect(accounts).toHaveLength(1);
    expect(accounts[0].key).toBe("key1");
  });

  it("金鑰重複的帳戶應被略過，避免並行操作同一把 key", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_ACCOUNTS: "1,2",
      BITFINEX_ACCOUNT1_KEY: "same-key",
      BITFINEX_ACCOUNT1_SECRET: "secret1",
      BITFINEX_ACCOUNT2_KEY: "same-key",
      BITFINEX_ACCOUNT2_SECRET: "secret2",
    });

    expect(accounts).toHaveLength(1);
  });

  it("完全沒有設定金鑰時應回傳空陣列", () => {
    expect(loadAccounts({})).toEqual([]);
  });

  it("應容忍帳戶清單中的空白", () => {
    const accounts = loadAccounts({
      FUNDING_BOT_ACCOUNTS: " 1 , 2 ",
      BITFINEX_ACCOUNT1_KEY: "key1",
      BITFINEX_ACCOUNT1_SECRET: "secret1",
      BITFINEX_ACCOUNT2_KEY: "key2",
      BITFINEX_ACCOUNT2_SECRET: "secret2",
    });

    expect(accounts).toHaveLength(2);
  });
});
