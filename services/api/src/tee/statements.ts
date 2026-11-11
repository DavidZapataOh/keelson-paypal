import type { Address, Hex } from "viem";

/** What a leg needs to sign the purchase's SCITT statement alongside its countersign. */
export interface StatementAsk {
  measurements: { tdx: Hex; nitro?: Hex };
  ref_salt?: Hex;
  leg_a?: { signer: Address | string; signature: Hex };
}

/** Whether a leg's `/v1/health` says it signs SCITT statements; a leg on an older engine does not. */
export function supportsStatements(health: unknown): boolean {
  return capabilitiesOf(health).statements;
}

/**
 * What a leg's engine does beyond the countersign of the oldest build still deployed, from its
 * `/v1/health`: each is off for an engine that does not report it, since an older engine refuses
 * a request carrying fields it does not know.
 */
export interface Capabilities {
  /** It signs the purchase's SCITT statement. */
  statements: boolean;
  /** It resolves decoy digests by the salts a request presents. */
  decoys: boolean;
  /** It checks a mandate's status list entry, and leg A signs the list. */
  status_list: boolean;
  /** Leg A's clock: `verified` when set from authenticated time at boot; absent on older engines. */
  clock?: "verified" | "unverified";
}

/** The {@link Capabilities} a leg's `/v1/health` reports. */
export function capabilitiesOf(health: unknown): Capabilities {
  const h = (health ?? {}) as Record<string, unknown>;
  return {
    statements: h.statements === 1,
    decoys: h.decoys === 1,
    status_list: h.status_list === 1,
    ...(h.clock === "verified" || h.clock === "unverified" ? { clock: h.clock } : {}),
  };
}

/** What no leg is known to do: the answer for a leg that cannot be reached. */
export const NO_CAPABILITIES: Capabilities = {
  statements: false,
  decoys: false,
  status_list: false,
};

/**
 * The `statement` field of a countersign request, or `undefined` for a leg that does not sign
 * statements: an older engine refuses unknown fields.
 */
export function statementAsk(o: {
  supports: boolean;
  measurements: { tdx: Hex; nitro: Hex | null };
  refSalt?: Hex | undefined;
  legA?: StatementAsk["leg_a"] | undefined;
}): StatementAsk | undefined {
  if (!o.supports) return undefined;
  return {
    measurements: {
      tdx: o.measurements.tdx,
      ...(o.measurements.nitro ? { nitro: o.measurements.nitro } : {}),
    },
    ...(o.refSalt ? { ref_salt: o.refSalt } : {}),
    ...(o.legA ? { leg_a: o.legA } : {}),
  };
}

/** The statement the log gets: leg B's (both legs) in 2of2, leg A's alone when degraded. */
export function chosenStatement(
  mode: "2of2" | "degraded",
  a: string | undefined,
  b: string | undefined,
): string | null {
  return (mode === "2of2" ? b : a) ?? null;
}
