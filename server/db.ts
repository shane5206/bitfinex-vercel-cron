import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from './_core/env';

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = 'admin';
      updateSet.role = 'admin';
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db.select().from(users).where(eq(users.openId, openId)).limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// TODO: add feature queries here as your schema grows.


// ===== Interest Snapshot Queries =====

import { interestSnapshots } from "../drizzle/schema";
import { gte, lt, desc, and } from "drizzle-orm";

/**
 * 查詢過去 N 天的利息快照
 * @param days 天數（預設 365 天 = 1 年）
 */
export async function queryInterestSnapshots(days: number = 365) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot query interest snapshots: database not available");
    return [];
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  try {
    return await db
      .select()
      .from(interestSnapshots)
      .where(gte(interestSnapshots.snapshotDate, startDate))
      .orderBy(desc(interestSnapshots.snapshotDate));
  } catch (error) {
    console.error("[Database] Failed to query interest snapshots:", error);
    return [];
  }
}

/**
 * 查詢指定帳戶過去 N 天的利息快照
 */
export async function queryInterestSnapshotsByAccount(
  accountName: string,
  days: number = 365
) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot query interest snapshots: database not available");
    return [];
  }

  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);

  try {
    return await db
      .select()
      .from(interestSnapshots)
      .where(
        and(
          gte(interestSnapshots.snapshotDate, startDate),
          eq(interestSnapshots.accountName, accountName)
        )
      )
      .orderBy(desc(interestSnapshots.snapshotDate));
  } catch (error) {
    console.error("[Database] Failed to query interest snapshots by account:", error);
    return [];
  }
}

/**
 * 寫入利息快照：同一帳戶同一日（UTC 日曆日）僅保留一筆，重複執行時覆蓋更新，
 * 避免手動觸發或重跑時重複累加利息。
 */
export async function insertInterestSnapshot(
  snapshotDate: Date,
  accountName: string,
  interestUsd: string,
  interestCount: number
) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot insert interest snapshot: database not available");
    return;
  }

  const startOfDay = new Date(
    Date.UTC(snapshotDate.getUTCFullYear(), snapshotDate.getUTCMonth(), snapshotDate.getUTCDate())
  );
  const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

  try {
    const existing = await db
      .select({ id: interestSnapshots.id })
      .from(interestSnapshots)
      .where(
        and(
          eq(interestSnapshots.accountName, accountName),
          gte(interestSnapshots.snapshotDate, startOfDay),
          lt(interestSnapshots.snapshotDate, endOfDay)
        )
      )
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(interestSnapshots)
        .set({ snapshotDate, interestUsd, interestCount })
        .where(eq(interestSnapshots.id, existing[0].id));
    } else {
      await db.insert(interestSnapshots).values({
        snapshotDate,
        accountName,
        interestUsd,
        interestCount,
      });
    }
  } catch (error) {
    console.error("[Database] Failed to insert interest snapshot:", error);
  }
}
