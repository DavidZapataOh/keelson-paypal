import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mandates, operators, user } from "@keelson/db";
import { ulid } from "ulid";
import { testDb } from "./setup.ts";

/** A mandate in `state`, with its user and operator. */
export async function channel3Mandate(state: "ACTIVE" | "REVOKED" = "ACTIVE"): Promise<string> {
  const userId = `user-${ulid()}`;
  await testDb.insert(user).values({ id: userId, name: "Tester", email: `${userId}@example.test` });
  const [operator] = await testDb
    .insert(operators)
    .values({
      agentId: BigInt(`0x${randomBytes(12).toString("hex")}`),
      chainId: 421614,
      name: "op",
      cnfJwk: {},
    })
    .returning();
  const id = ulid();
  await testDb.insert(mandates).values({
    id,
    userId,
    operatorAgentId: (operator as { agentId: bigint }).agentId,
    state,
    currency: "USD",
    maxMinor: 10_000n,
    remainingMinor: 10_000n,
    merchantIds: ["shopwss.com"],
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return id;
}

export interface CapturedLookup {
  captured_at: string;
  url: string;
  body_b64: string;
}

/** A real lookup captured into the core package's fixtures. */
export function capturedLookup(name: string): CapturedLookup & { product: unknown } {
  const f = JSON.parse(
    readFileSync(
      new URL(`../../../packages/core/test/fixtures/channel3/${name}.json`, import.meta.url),
      "utf8",
    ),
  ) as CapturedLookup;
  return { ...f, product: JSON.parse(Buffer.from(f.body_b64, "base64").toString("utf8")).product };
}

export const asClient = (subject: string) => ({
  "x-test-principal": JSON.stringify({ kind: "client", subject, scopes: ["countersign:write"] }),
});
