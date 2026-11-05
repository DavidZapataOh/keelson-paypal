import { type Json, jcs, sha256 } from "@keelson/core";
import {
  Disclosure,
  type DisclosureFrame,
  getClaimsSync,
  pack,
  uint8ArrayToBase64Url,
} from "@sd-jwt/core";
import { type Mandate, parseMandate } from "./schema.ts";

/** The SD-JWT `sha-256` hasher (RFC 9901 section 4.2.3); every other algorithm is refused. */
export function sdHasher(data: string | ArrayBuffer, alg: string): Uint8Array {
  if (alg !== "sha-256") throw new RangeError(`unsupported _sd_alg ${alg}`);
  return sha256(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
}

/** The selectively disclosable parts of a mandate; every array entry gets its own disclosure. */
export const SD_FIELDS: readonly string[] = [
  "user.app_login_id",
  "payment.constraints[type=payment.amount_range]",
  "payment.constraints[type=payment.allowed_payees].allowed[*]",
  "checkout.constraints[type=checkout.allowed_merchants].allowed[*]",
  "checkout.constraints[type=checkout.line_items].items[*].acceptable_items[*]",
  "intent.prompt_summary",
  "risk_data",
];

const indices = (xs: readonly unknown[]): number[] => xs.map((_, i) => i);

type SdClaims = Mandate & { cnf: { jwk: Mandate["agent"]["cnf"]["jwk"] } };

/** The `@sd-jwt/core` disclosure frame that makes {@link SD_FIELDS} selectively disclosable. */
function disclosureFrame(m: Mandate): DisclosureFrame<SdClaims> {
  const payment: Record<number, object> & { _sd: number[] } = { _sd: [] };
  m.payment.constraints.forEach((c, i) => {
    if (c.type === "payment.amount_range") payment._sd.push(i);
    if (c.type === "payment.allowed_payees") payment[i] = { allowed: { _sd: indices(c.allowed) } };
  });
  const checkout: Record<number, object> = {};
  m.checkout.constraints.forEach((c, i) => {
    if (c.type === "checkout.allowed_merchants") {
      checkout[i] = { allowed: { _sd: indices(c.allowed) } };
    }
    if (c.type === "checkout.line_items") {
      checkout[i] = {
        items: Object.fromEntries(
          c.items.map((item, j) => [
            j,
            { acceptable_items: { _sd: indices(item.acceptable_items) } },
          ]),
        ),
      };
    }
  });
  return {
    _sd: ["risk_data"],
    user: { _sd: ["app_login_id"] },
    intent: { _sd: ["prompt_summary"] },
    payment: { constraints: payment },
    checkout: { constraints: checkout },
  } as DisclosureFrame<SdClaims>;
}

/**
 * Builds `payload_SD`: the mandate with the {@link SD_FIELDS} replaced by digests (RFC 9901
 * section 4.2), plus the top-level `cnf` that makes the agent key the delegate holder key. Each
 * salt is the base64url encoding of one 16-byte `randomSalt()`.
 */
export async function buildSdPayload(
  input: Mandate,
  randomSalt: () => Uint8Array,
): Promise<{ payloadSd: object; disclosures: string[] }> {
  const m = parseMandate(input);
  const salt = () => {
    const s = randomSalt();
    if (s.length !== 16) throw new RangeError("salt must be 16 bytes");
    return uint8ArrayToBase64Url(s);
  };
  const { packedClaims, disclosures } = await pack(
    { ...m, cnf: { jwk: m.agent.cnf.jwk } } satisfies SdClaims,
    disclosureFrame(m),
    { hasher: sdHasher, alg: "sha-256" },
    salt,
  );
  return { payloadSd: packedClaims, disclosures: disclosures.map((d) => d.encode()) };
}

/**
 * Applies `disclosures` to `payloadSd` (RFC 9901 section 7.1, step 3): every disclosure must match
 * exactly one digest, and duplicates are rejected. Fields whose disclosure is missing are absent
 * from the result, so it is a full {@link Mandate} only when every disclosure is given.
 */
export function decodeDisclosed(payloadSd: object, disclosures: string[]): Mandate {
  const decoded = disclosures.map((d) =>
    Disclosure.fromEncodeSync(d, { hasher: sdHasher, alg: "sha-256" }),
  );
  const { cnf, ...m } = getClaimsSync<Mandate & { cnf?: unknown }>(
    payloadSd as Record<string, unknown>,
    decoded,
    sdHasher,
  );
  if (jcs({ jwk: m.agent?.cnf?.jwk } as Json) !== jcs((cnf ?? null) as Json)) {
    throw new RangeError("cnf differs from agent.cnf");
  }
  return m;
}
