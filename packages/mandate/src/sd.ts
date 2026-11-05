import { type Json, jcs, sha256 } from "@keelson/core";
import {
  Disclosure,
  type DisclosureFrame,
  getClaimsSync,
  pack,
  uint8ArrayToBase64Url,
} from "@sd-jwt/core";
import { type Mandate, parseMandate } from "./schema.ts";
import { assertDigestsResolved, assertStrictJson, decodeStrictJson } from "./strict.ts";

/** The SD-JWT `sha-256` hasher (RFC 9901 section 4.2.3); every other algorithm is refused. */
export function sdHasher(data: string | ArrayBuffer, alg: string): Uint8Array {
  if (alg !== "sha-256") throw new RangeError(`unsupported _sd_alg ${alg}`);
  return sha256(typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
}

/** Rejects a payload whose `_sd_alg` is present and not `sha-256` (RFC 9901 section 4.1.1). */
export function assertSdAlg(payload: object): void {
  const alg = (payload as { _sd_alg?: unknown })._sd_alg;
  if (alg !== undefined && alg !== "sha-256") throw new RangeError(`unsupported _sd_alg ${alg}`);
}

/** The selectively disclosable parts of a mandate; every array entry gets its own disclosure. */
export const SD_FIELDS: readonly string[] = [
  "user.sub",
  "user.cred",
  "user.app_login_id",
  "payment.constraints[type=payment.amount_range]",
  "payment.constraints[type=payment.budget].max",
  "payment.constraints[type=payment.allowed_payees].allowed[*]",
  "checkout.constraints[type=checkout.allowed_merchants].allowed[*]",
  "checkout.constraints[type=checkout.line_items].items[*].acceptable_items[*]",
  "intent.prompt_summary",
  "intent.prompt_hash",
  "risk_data",
];

const indices = (xs: readonly unknown[]): number[] => xs.map((_, i) => i);

type SdClaims = Mandate & { cnf: { jwk: Mandate["agent"]["cnf"]["jwk"] } };

/** The `@sd-jwt/core` disclosure frame that makes {@link SD_FIELDS} selectively disclosable. */
function disclosureFrame(m: Mandate): DisclosureFrame<SdClaims> {
  const payment: Record<number, object> & { _sd: number[] } = { _sd: [] };
  m.payment.constraints.forEach((c, i) => {
    if (c.type === "payment.amount_range") payment._sd.push(i);
    if (c.type === "payment.budget") payment[i] = { _sd: ["max"] };
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
    user: { _sd: ["sub", "cred", "app_login_id"] },
    intent: { _sd: ["prompt_summary", "prompt_hash"] },
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

/** A value with any object member possibly absent, as selective disclosure leaves it. */
export type Disclosed<T> = T extends readonly (infer U)[]
  ? Disclosed<U>[]
  : T extends object
    ? { [K in keyof T]?: Disclosed<T[K]> }
    : T;

/**
 * Applies `disclosures` to `payloadSd` (RFC 9901 section 7.1, step 3): every disclosure must match
 * exactly one digest, and duplicates are rejected. The payload, the disclosures and the result
 * must pass {@link assertStrictJson}. Fields and array elements whose disclosure is missing are
 * absent from the result; use {@link decodeMandate} when every disclosure is required.
 */
export function decodeDisclosed(payloadSd: object, disclosures: string[]): Disclosed<Mandate> {
  assertSdAlg(payloadSd);
  assertStrictJson(payloadSd);
  const decoded = disclosures.map((d) => {
    decodeStrictJson(d);
    return Disclosure.fromEncodeSync(d, { hasher: sdHasher, alg: "sha-256" });
  });
  const claims = getClaimsSync<Mandate & { cnf?: unknown }>(
    payloadSd as Record<string, unknown>,
    decoded,
    sdHasher,
  );
  assertStrictJson(claims);
  const { cnf, ...m } = claims;
  if (jcs({ jwk: m.agent?.cnf?.jwk } as Json) !== jcs((cnf ?? null) as Json)) {
    throw new RangeError("cnf differs from agent.cnf");
  }
  return m;
}

/**
 * {@link decodeDisclosed} for a fully disclosed mandate: every digest in `payloadSd` and in the
 * disclosures must be resolved, and the result is parsed with {@link parseMandate}.
 */
export function decodeMandate(payloadSd: object, disclosures: string[]): Mandate {
  const m = decodeDisclosed(payloadSd, disclosures);
  assertDigestsResolved(payloadSd, disclosures);
  return parseMandate(m);
}

export interface MerchantView {
  /** `id` of the merchant in `checkout.allowed_merchants`. */
  merchant: string;
  /** `id`s of the `acceptable_items` entries the merchant is offering. */
  items?: readonly string[];
  /** Whether the user chooses to reveal the per-purchase cap, `payment.amount_range`. */
  cap?: boolean;
}

const keysOf = (v: unknown): string =>
  v !== null && typeof v === "object" ? Object.keys(v).sort().join() : "";

/**
 * Selects the disclosures a merchant receives: its own `allowed_merchants` and `allowed_payees`
 * entries, the requested `acceptable_items` entries, and the cap only when `view.cap` is set.
 * Every other disclosure, including `user`, `prompt_hash` and the budget's `max`, is withheld.
 */
export function merchantDisclosures(disclosures: string[], view: MerchantView): string[] {
  const decoded = disclosures.map((encoded) => ({
    encoded,
    d: Disclosure.fromEncodeSync<Record<string, unknown>>(encoded, {
      hasher: sdHasher,
      alg: "sha-256",
    }),
  }));
  const elements = decoded.filter(({ d }) => d.key === undefined);
  const merchant = elements.find(
    ({ d }) =>
      keysOf(d.value) === "id,name,paypal_merchant_id,website" && d.value.id === view.merchant,
  )?.d.value;
  if (!merchant) throw new RangeError(`merchant ${view.merchant} is not in the mandate`);
  const items = new Set(view.items ?? []);
  return elements
    .filter(({ d: { value } }) => {
      switch (keysOf(value)) {
        case "id,name,paypal_merchant_id,website":
          return value === merchant;
        case "paypal_merchant_id":
          return value.paypal_merchant_id === merchant.paypal_merchant_id;
        case "id":
        case "id,title":
          return items.has(value.id as string);
        default:
          return view.cap === true && value.type === "payment.amount_range";
      }
    })
    .map(({ encoded }) => encoded);
}
