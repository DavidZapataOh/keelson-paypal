import { and, eq, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { disputes, mandates, purchases } from "./schema/index.ts";

/** Allowed state changes. Mirrors the `state_transitions` table. */
export const transitions = {
  mandates: {
    DRAFT: ["COMPILED"],
    COMPILED: ["SIGNED"],
    SIGNED: ["HOLD_PENDING", "ACTIVE", "REVOKED", "EXPIRED"],
    HOLD_PENDING: ["ACTIVE", "REVOKED", "EXPIRED"],
    ACTIVE: ["EXHAUSTED", "EXPIRED", "REVOKED"],
  },
  purchases: {
    PROPOSED: ["EVALUATING"],
    EVALUATING: ["DENIED", "COUNTERSIGNED", "FAILED"],
    FAILED: ["EVALUATING", "CAPTURED"],
    COUNTERSIGNED: ["LOGGED", "FAILED"],
    LOGGED: ["COVERED", "FAILED"],
    COVERED: ["CAPTURED", "FAILED"],
    CAPTURED: ["DELIVERED", "SETTLED", "DISPUTED"],
    DELIVERED: ["SETTLED", "DISPUTED"],
    DISPUTED: ["ATTRIBUTED"],
    ATTRIBUTED: ["SLASHED", "WARRANTY_PAID", "DEFENDED", "MERCHANT_LIABLE"],
  },
  disputes: {
    OPEN: ["ATTRIBUTED", "RESOLVED"],
    ATTRIBUTED: ["RESOLVED"],
  },
} as const;

type Transitions = typeof transitions;
type TableName = keyof Transitions;
type Tables = { mandates: typeof mandates; purchases: typeof purchases; disputes: typeof disputes };
type Patch<T extends TableName> = Partial<
  Omit<Tables[T]["$inferInsert"], "id" | "state" | "updatedAt">
>;

const tables: Tables = { mandates, purchases, disputes };

/**
 * Moves a row from `from` to `to` in one conditional UPDATE, on `db` or inside a transaction.
 * Resolves to `false` when the row is no longer in `from`.
 */
export async function transition<T extends TableName, F extends keyof Transitions[T]>(
  db: Pick<Db, "update">,
  table: T,
  id: string,
  from: F,
  to: Transitions[T][F] extends readonly (infer S)[] ? S : never,
  patch?: Patch<T>,
): Promise<boolean> {
  const t = tables[table];
  const result = await db
    .update(t)
    .set({ ...patch, state: to, updatedAt: sql`now()` } as never)
    .where(and(eq(t.id, id), eq(t.state, from as never)));
  return result.rowCount === 1;
}
