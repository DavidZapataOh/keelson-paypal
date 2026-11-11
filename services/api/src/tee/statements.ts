import type { Address, Hex } from "viem";

/** What a leg needs to sign the purchase's SCITT statement alongside its countersign. */
export interface StatementAsk {
  measurements: { tdx: Hex; nitro?: Hex };
  ref_salt?: Hex;
  leg_a?: { signer: Address | string; signature: Hex };
}

/** Whether a leg's `/v1/health` says it signs SCITT statements; a leg on an older engine does not. */
export function supportsStatements(health: unknown): boolean {
  return (health as { statements?: unknown } | null)?.statements === 1;
}

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
