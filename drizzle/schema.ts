import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";

/**
 * Core user table backing auth flow.
 * Extend this file with additional tables as your product grows.
 * Columns use camelCase to match both database fields and generated types.
 */
export const users = mysqlTable("users", {
  /**
   * Surrogate primary key. Auto-incremented numeric value managed by the database.
   * Use this for relations between tables.
   */
  id: int("id").autoincrement().primaryKey(),
  /** Manus OAuth identifier (openId) returned from the OAuth callback. Unique per user. */
  openId: varchar("openId", { length: 64 }).notNull().unique(),
  name: text("name"),
  email: varchar("email", { length: 320 }),
  loginMethod: varchar("loginMethod", { length: 64 }),
  role: mysqlEnum("role", ["user", "admin"]).default("user").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
  lastSignedIn: timestamp("lastSignedIn").defaultNow().notNull(),
});

export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

/**
 * 每日利息快照表
 * 存儲每日自動執行 Cron Job 時的利息數據
 */
export const interestSnapshots = mysqlTable("interestSnapshots", {
  id: int("id").autoincrement().primaryKey(),
  /** 快照日期 (UTC) */
  snapshotDate: timestamp("snapshotDate").notNull(),
  /** 帳戶名稱 (e.g., Account 1, Account 2) */
  accountName: varchar("accountName", { length: 64 }).notNull(),
  /** 該帳戶該日期的利息總額 (USD) */
  interestUsd: text("interestUsd").notNull(),
  /** 該帳戶該日期的利息筆數 */
  interestCount: int("interestCount").notNull(),
  /** 該帳戶該日期的 funding 錢包本金 (USD)，用於計算年化報酬率 */
  principalUsd: text("principalUsd"),
  /** 記錄建立時間 */
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

export type InterestSnapshot = typeof interestSnapshots.$inferSelect;
export type InsertInterestSnapshot = typeof interestSnapshots.$inferInsert;
