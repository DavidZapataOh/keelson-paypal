import { getCedarLangVersion, getCedarVersion } from "@cedar-policy/cedar-wasm";
import { type Cart, cartHash } from "@keelson/core";
import type { mandates } from "@keelson/db";
import { decodeMandate } from "@keelson/mandate";
import { cartContext, type EngineMeta, evaluate, mandateAgent } from "@keelson/policy";
import { type FieldCheck, fieldChecks } from "./pipeline/drive.ts";

/** The evaluator a check runs: the policy set the TEE legs run, in process, with no proof bundle. */
const EVALUATOR: EngineMeta = {
  cedar_policy: getCedarVersion(),
  lang: getCedarLangVersion(),
  symcc: "",
  cvc5: "",
  oci_digest: "",
  canonicalizer: "@keelson/api check",
  proof_bundle_hash: "",
};

/**
 * Each mandate field checked against the cart by the same policy set the TEE legs run, with
 * nothing signed: empty when the mandate is not signed.
 */
export function cartChecks(mandate: typeof mandates.$inferSelect, cart: Cart): FieldCheck[] {
  if (!mandate.payloadSd || !mandate.disclosures || !mandate.mandateHash) return [];
  let m: ReturnType<typeof decodeMandate>;
  try {
    m = decodeMandate(mandate.payloadSd as Record<string, unknown>, mandate.disclosures);
  } catch {
    return [];
  }
  const trace = evaluate(
    {
      mandate: m,
      budgetLeftMinor: Number(mandate.remainingMinor),
      agent: mandateAgent(m),
      context: cartContext(cart),
      now: new Date(),
      evidence: {},
      mandateHash: mandate.mandateHash,
      cartHash: cartHash(cart),
    },
    EVALUATOR,
  );
  return fieldChecks(trace, cart.currency);
}
