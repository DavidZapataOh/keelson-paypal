import { addresses } from "@keelson/chain";
import type { Db, operators } from "@keelson/db";
import { type Mandate, TERMS_HASH } from "@keelson/mandate";
import { calculateJwkThumbprint } from "jose";

/** A mandate input that cannot be filled now; compiling answers 503 naming it. */
export class SourceUnavailable extends Error {
  override name = "SourceUnavailable";
  readonly source: string;
  constructor(source: string) {
    super(`${source} is not available`);
    this.source = source;
  }
}

/** The smallest bond the operator holds for a mandate's amber fields: 50 PYUSD, in its 6-decimal units. */
const BOND_MIN = 50_000_000;

type Operator = typeof operators.$inferSelect;

/** The operator's agent proof-of-possession key, or undefined while it registered no P-256 key. */
export async function agentCnf(
  row: Pick<Operator, "cnfJwk">,
): Promise<Mandate["agent"]["cnf"] | undefined> {
  const jwk = row.cnfJwk as { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown };
  if (
    jwk?.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string"
  ) {
    return undefined;
  }
  const key = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
  return { jwk: { ...key, kid: await calculateJwkThumbprint(key) } };
}

/** The bond the operator holds for a mandate, or undefined on a chain without a bond vault. */
export function agentBond(row: Pick<Operator, "chainId">): Mandate["agent"]["bond"] | undefined {
  const vault = addresses[row.chainId as keyof typeof addresses]?.KeelsonBondVault;
  return vault
    ? { vault: `eip155:${row.chainId}:${vault}`, asset: "PYUSD", min: BOND_MIN }
    : undefined;
}

/**
 * The agent the app's mandates delegate to: the registered operator `agentId`, its agent's
 * proof-of-possession key and its bond vault. Unavailable until the operator registered a P-256
 * `cnf` key with `POST /v1/operators`.
 */
export function operatorAgent(db: Db, agentId: bigint): () => Promise<Mandate["agent"]> {
  return async () => {
    const row = await db.query.operators.findFirst({
      where: (o, { eq }) => eq(o.agentId, agentId),
    });
    const cnf = row && (await agentCnf(row));
    const bond = row && agentBond(row);
    if (!row || !cnf || !bond) throw new SourceUnavailable("agent");
    return {
      operator: { agent_registry: row.agentRegistry, agent_id: agentId.toString() },
      cnf,
      bond,
    };
  };
}

/**
 * The consent a signed mandate records: the user accepts the terms the app shows, whose hash the
 * passkey signs with the rest of the mandate.
 */
export const termsConsent = async (): Promise<Mandate["consent"]> => ({
  terms_hash: TERMS_HASH,
  instruction_use: true,
  responsibility_ack: true,
  merchant_policy_ack: "at_capture",
  recurrence_ack: false,
});
