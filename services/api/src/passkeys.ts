import type { Db, passkey } from "@keelson/db";

export type Passkey = typeof passkey.$inferSelect;

/** Lists the passkeys registered to `userId`, oldest first. */
export function userPasskeys(db: Db, userId: string): Promise<Passkey[]> {
  return db.query.passkey.findMany({
    where: (row, { eq }) => eq(row.userId, userId),
    orderBy: (row, { asc }) => [asc(row.createdAt), asc(row.id)],
  });
}
