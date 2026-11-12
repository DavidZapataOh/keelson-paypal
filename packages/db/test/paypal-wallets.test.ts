import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, test } from "vitest";
import { mandates, paypalWallets, user } from "../src/index.ts";
import { testDb } from "./setup.ts";

const { db } = testDb;

async function newUser(): Promise<string> {
  const id = `kls_usr_${randomBytes(8).toString("hex")}`;
  await db.insert(user).values({ id, name: "u", email: `${id}@example.com` });
  return id;
}

const wallet = (userId: string) => ({
  userId,
  vaultId: randomBytes(4).toString("hex"),
  customerId: randomBytes(5).toString("hex"),
  email: "buyer@example.com",
});

test("a user has at most one saved PayPal", async () => {
  const userId = await newUser();
  await db.insert(paypalWallets).values(wallet(userId));
  await expect(db.insert(paypalWallets).values(wallet(userId))).rejects.toThrow();
});

test("a vault id belongs to one user", async () => {
  const first = wallet(await newUser());
  await db.insert(paypalWallets).values(first);
  await expect(
    db.insert(paypalWallets).values({ ...wallet(await newUser()), vaultId: first.vaultId }),
  ).rejects.toThrow();
});

test("the email is optional and the time is set", async () => {
  const userId = await newUser();
  const { email: _, ...row } = wallet(userId);
  await db.insert(paypalWallets).values(row);
  const [saved] = await db.select().from(paypalWallets).where(eq(paypalWallets.userId, userId));
  expect(saved?.email).toBeNull();
  expect(saved?.createdAt).toBeInstanceOf(Date);
});

test("deleting the user deletes their saved PayPal", async () => {
  const userId = await newUser();
  await db.insert(paypalWallets).values(wallet(userId));
  await db.delete(user).where(eq(user.id, userId));
  expect(
    await db.select().from(paypalWallets).where(eq(paypalWallets.userId, userId)),
  ).toHaveLength(0);
});

test("a mandate records the saved PayPal its hold used, if any", () => {
  expect(mandates.paypalVaultId.notNull).toBe(false);
});
