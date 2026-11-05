import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import type { Db } from "./client.ts";
import { disputes, events, mandates, openPurchase, purchases } from "./schema/index.ts";

const ph = (name: string) => sql.placeholder(name);

/** Prepares the hot-path statements once per connection pool. */
export function createQueries(db: Db) {
  const mandateById = db
    .select()
    .from(mandates)
    .where(eq(mandates.id, ph("id")))
    .prepare("mandate_by_id");

  const mandatesFirstPage = db
    .select()
    .from(mandates)
    .where(eq(mandates.userId, ph("userId")))
    .orderBy(desc(mandates.createdAt), desc(mandates.id))
    .limit(ph("limit"))
    .prepare("mandates_by_user");

  const mandatesNextPage = db
    .select()
    .from(mandates)
    .where(
      and(
        eq(mandates.userId, ph("userId")),
        sql`(${mandates.createdAt}, ${mandates.id}) < (select created_at, id from mandates where id = ${ph("before")})`,
      ),
    )
    .orderBy(desc(mandates.createdAt), desc(mandates.id))
    .limit(ph("limit"))
    .prepare("mandates_by_user_before");

  const purchaseById = db
    .select()
    .from(purchases)
    .where(eq(purchases.id, ph("id")))
    .prepare("purchase_by_id");

  const purchasesFirstPage = db
    .select()
    .from(purchases)
    .where(eq(purchases.mandateId, ph("mandateId")))
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .limit(ph("limit"))
    .prepare("purchases_by_mandate");

  const purchasesNextPage = db
    .select()
    .from(purchases)
    .where(
      and(
        eq(purchases.mandateId, ph("mandateId")),
        sql`(${purchases.createdAt}, ${purchases.id}) < (select created_at, id from purchases where id = ${ph("before")})`,
      ),
    )
    .orderBy(desc(purchases.createdAt), desc(purchases.id))
    .limit(ph("limit"))
    .prepare("purchases_by_mandate_before");

  const purchaseByInvoiceId = db
    .select()
    .from(purchases)
    .where(eq(purchases.invoiceId, ph("invoiceId")))
    .prepare("purchase_by_invoice_id");

  const purchaseByCaptureId = db
    .select()
    .from(purchases)
    .where(eq(purchases.paypalCaptureId, ph("captureId")))
    .prepare("purchase_by_capture_id");

  const openPurchases = db
    .select()
    .from(purchases)
    .where(openPurchase(purchases.state))
    .orderBy(asc(purchases.createdAt), asc(purchases.id))
    .limit(ph("limit"))
    .prepare("open_purchases");

  const disputeById = db
    .select()
    .from(disputes)
    .where(eq(disputes.id, ph("id")))
    .prepare("dispute_by_id");

  const eventsAfter = db
    .select()
    .from(events)
    .where(and(eq(events.channel, ph("channel")), gt(events.id, ph("afterId"))))
    .orderBy(asc(events.id))
    .limit(ph("limit"))
    .prepare("events_after");

  return {
    mandateById: async (id: string) => (await mandateById.execute({ id }))[0],
    mandatesByUser: (userId: string, limit: number, beforeId?: string) =>
      beforeId === undefined
        ? mandatesFirstPage.execute({ userId, limit })
        : mandatesNextPage.execute({ userId, limit, before: beforeId }),
    purchaseById: async (id: string) => (await purchaseById.execute({ id }))[0],
    purchasesByMandate: (mandateId: string, limit: number, beforeId?: string) =>
      beforeId === undefined
        ? purchasesFirstPage.execute({ mandateId, limit })
        : purchasesNextPage.execute({ mandateId, limit, before: beforeId }),
    purchaseByInvoiceId: async (invoiceId: string) =>
      (await purchaseByInvoiceId.execute({ invoiceId }))[0],
    purchaseByCaptureId: async (captureId: string) =>
      (await purchaseByCaptureId.execute({ captureId }))[0],
    openPurchases: (limit: number) => openPurchases.execute({ limit }),
    disputeById: async (id: string) => (await disputeById.execute({ id }))[0],
    eventsAfter: (channel: string, afterId: bigint, limit: number) =>
      eventsAfter.execute({ channel, afterId, limit }),
  };
}

export type Queries = ReturnType<typeof createQueries>;
