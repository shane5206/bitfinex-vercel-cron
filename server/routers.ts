import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { runDailyReport } from "./cron/daily-report";
import { queryInterestSnapshots, queryInterestSnapshotsByAccount } from "./db";
import { z } from "zod";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),

  cron: router({
    /**
     * 手動觸發每日利息報告（公開端點，由前端 Dashboard 呼叫）
     */
    triggerReport: publicProcedure.mutation(async () => {
      return await runDailyReport();
    }),
  }),

  interest: router({
    /**
     * 查詢過去 N 天的利息快照
     */
    getSnapshots: publicProcedure
      .input(z.object({ days: z.number().int().positive().default(365) }))
      .query(async ({ input }) => {
        return await queryInterestSnapshots(input.days);
      }),

    /**
     * 查詢指定帳戶過去 N 天的利息快照
     */
    getSnapshotsByAccount: publicProcedure
      .input(
        z.object({
          accountName: z.string(),
          days: z.number().int().positive().default(365),
        })
      )
      .query(async ({ input }) => {
        return await queryInterestSnapshotsByAccount(input.accountName, input.days);
      }),
  }),
});

export type AppRouter = typeof appRouter;
