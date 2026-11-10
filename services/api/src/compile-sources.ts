import { addresses } from "@keelson/chain";
import type { Db } from "@keelson/db";
import { type Mandate, TERMS_HASH } from "@keelson/mandate";
import { calculateJwkThumbprint } from "jose";

/** A mandate input that cannot be filled now; compiling answers 503 naming it. */
export class SourceUnavailable extends Error {
  override name = "SourceUnavailable";
  constructor(readonly source: string) {
    super(`${source} is not available`);
  }
}

/** The smallest bond, in PYUSD minor units, the operator holds for a mandate's amber fields. */
const BOND_MIN = 5000;

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
    const jwk = row?.cnfJwk as
      | { kty?: unknown; crv?: unknown; x?: unknown; y?: unknown }
      | undefined;
    const vault = row && addresses[row.chainId as keyof typeof addresses]?.KeelsonBondVault;
    if (
      !row ||
      !vault ||
      jwk?.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string"
    ) {
      throw new SourceUnavailable("agent");
    }
    const key = { kty: "EC" as const, crv: "P-256" as const, x: jwk.x, y: jwk.y };
    return {
      operator: { agent_registry: row.agentRegistry, agent_id: agentId.toString() },
      cnf: { jwk: { ...key, kid: await calculateJwkThumbprint(key) } },
      bond: { vault: `eip155:${row.chainId}:${vault}`, asset: "PYUSD", min: BOND_MIN },
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
