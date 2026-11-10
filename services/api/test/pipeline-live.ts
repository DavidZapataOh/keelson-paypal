import { readFileSync } from "node:fs";
import { KMSClient } from "@aws-sdk/client-kms";
import { addresses } from "@keelson/chain";
import { and, type Db, eq, operators, sql } from "@keelson/db";
import { createRelayer, kmsAccount, type Relayer } from "@keelson/relayer";
import type { Logger } from "pino";
import type { Address } from "viem";
import { agentCnf } from "../src/compile-sources.ts";
import { carts, testAgent } from "./tee-live.ts";

const registry = JSON.parse(
  readFileSync(new URL("../../../contracts/deployments/421614.json", import.meta.url), "utf8"),
) as { demo: { agentId: number } };

/** The demo store: the sandbox account whose credentials create and capture holds. */
export const STORE = "A4WCRYD5EYDF2";

/** The demo operator: its key signs the coverage of the purchases under its mandates. */
export const AGENT_ID = BigInt(registry.demo.agentId);
export const VAULT = addresses[421614].KeelsonBondVault as Address;
export const demoOperator = { agentId: AGENT_ID };

/** The demo cart at another price. */
export function cartOf(minor: number) {
  const value = (minor / 100).toFixed(2);
  return {
    cart: {
      ...carts.demo.cart,
      lines: carts.demo.cart.lines.map((l) => ({ ...l, unit_minor: minor })),
    },
    unit: {
      amount: {
        currency_code: "USD",
        value,
        breakdown: { item_total: { currency_code: "USD", value } },
      },
    },
  };
}

/** The relayer of Arbitrum Sepolia, signing with the sandbox KMS key. */
export async function kmsRelayer(db: Db, log: Logger): Promise<Relayer> {
  const kms = new KMSClient({
    region: process.env.AWS_REGION ?? "us-west-2",
    credentials: {
      accessKeyId: process.env.RELAYER_AWS_ACCESS_KEY_ID as string,
      secretAccessKey: process.env.RELAYER_AWS_SECRET_ACCESS_KEY as string,
    },
  });
  return createRelayer({
    db,
    log,
    chains: {
      421614: {
        rpcUrl: process.env.ARBITRUM_SEPOLIA_RPC_URL as string,
        fallbackRpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
        account: await kmsAccount({
          keyId: process.env.RELAYER_KMS_KEY_SANDBOX as string,
          client: kms,
        }),
      },
    },
  });
}

/**
 * The demo operator's row, with {@link testAgent} as its agent. On a database where the operator
 * registered no agent key, this process's key stands in for the run; the returned function puts the
 * row back. A registered key is never replaced: the harness then cannot buy as the operator's agent.
 */
export async function seedDemoOperator(db: Db): Promise<() => Promise<void>> {
  await db
    .insert(operators)
    .values({
      agentId: AGENT_ID,
      chainId: 421614,
      agentRegistry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
      name: "Demo operator",
      cnfJwk: testAgent.jwk,
    })
    .onConflictDoNothing();
  const [row] = await db.select().from(operators).where(eq(operators.agentId, AGENT_ID));
  const ours = await agentCnf({ cnfJwk: testAgent.jwk });
  const theirs = row && (await agentCnf(row));
  if (theirs?.jwk.kid === ours?.jwk.kid) return async () => {};
  if (theirs) {
    throw new Error(`operator ${AGENT_ID} registered its own agent key; buy with that key`);
  }
  const before = row?.cnfJwk ?? {};
  await db.update(operators).set({ cnfJwk: testAgent.jwk }).where(eq(operators.agentId, AGENT_ID));
  return async () => {
    await db
      .update(operators)
      .set({ cnfJwk: before })
      .where(
        and(
          eq(operators.agentId, AGENT_ID),
          sql`${operators.cnfJwk} = ${JSON.stringify(testAgent.jwk)}::jsonb`,
        ),
      );
  };
}
