import { type Json, jcs, sha256 } from "@keelson/core";
import {
  Disclosure,
  type DisclosureFrame,
  getClaimsSync,
  pack,
  uint8ArrayToBase64Url,
} from "@sd-jwt/core";
import { type Mandate, parseMandate } from "./schema.ts";
import { assertDigestsResolved, assertStrictJson, decodeStrictJson, MAX_DEPTH } from "./strict.ts";

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

/**
 * The claims a public presentation of a mandate withholds: the user's login id and the risk data
 * (device and IP). Their digests stay in the signed payload, so they remain committed to.
 */
export const PERSONAL_CLAIMS: readonly string[] = ["app_login_id", "risk_data"];

/** Whether `disclosure` is an object claim named in {@link PERSONAL_CLAIMS}. */
export function isPersonalDisclosure(disclosure: string): boolean {
  const d = decodeStrictJson(disclosure) as unknown[];
  return d.length === 3 && PERSONAL_CLAIMS.includes(d[1] as string);
}

/** An SD-JWT presentation (`jwt~d1~…~dn~[kb]`) without the {@link PERSONAL_CLAIMS} disclosures. */
export function withholdPersonal(presentation: string): string {
  return presentation
    .split("~")
    .filter(
      (part, i) => i === 0 || part === "" || part.includes(".") || !isPersonalDisclosure(part),
    )
    .join("~");
}

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

/** The sizes a padded `_sd` list or SD array grows to (RFC 9901 section 4.2.5). */
const DECOY_BUCKETS = [4, 8, 16, 32, 64] as const;
/** The most digests a mandate may carry, as the engine bounds its disclosures. */
const MAX_DIGESTS = 512;

/** The digest a decoy salt stands for: SHA-256 over the ASCII of its base64url form. */
function decoyDigest(salt: string): string {
  return uint8ArrayToBase64Url(sdHasher(salt, "sha-256"));
}

/**
 * Pads every `_sd` list and every array of `{"...": digest}` elements of `payload` with decoy
 * digests up to the next of {@link DECOY_BUCKETS}, never past {@link MAX_DIGESTS} in all. A `_sd`
 * list is sorted after; an array's decoys go to random positions. Returns the decoy salts.
 */
function padWithDecoys(payload: object, total: number, salt: () => string): string[] {
  const salts: string[] = [];
  const decoy = () => {
    const s = salt();
    salts.push(s);
    return decoyDigest(s);
  };
  const target = (n: number) => DECOY_BUCKETS.find((b) => b >= n) ?? n;
  const room = (n: number) => Math.max(0, Math.min(target(n) - n, MAX_DIGESTS - total));
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item);
      const sd = v.filter((x) => x !== null && typeof x === "object" && "..." in x).length;
      if (sd === 0) return;
      for (let i = room(sd); i > 0; i--, total++) {
        const at = (salt().charCodeAt(0) * 31 + i) % (v.length + 1);
        v.splice(at, 0, { "...": decoy() });
      }
      return;
    }
    const o = v as Record<string, unknown>;
    for (const item of Object.values(o)) walk(item);
    if (Array.isArray(o._sd) && o._sd.length > 0) {
      for (let i = room(o._sd.length); i > 0; i--, total++) o._sd.push(decoy());
      o._sd.sort();
    }
  };
  walk(payload);
  return salts;
}

/**
 * Builds `payload_SD`: the mandate with the {@link SD_FIELDS} replaced by digests (RFC 9901
 * section 4.2), plus the top-level `cnf` that makes the agent key the delegate holder key. Each
 * salt is the base64url encoding of one 16-byte `randomSalt()`. With `decoys`, every `_sd` list
 * and SD array is padded with decoy digests, which only the returned `decoySalts` resolve.
 */
export async function buildSdPayload(
  input: Mandate,
  randomSalt: () => Uint8Array,
  opts: { decoys?: boolean } = {},
): Promise<{ payloadSd: object; disclosures: string[]; decoySalts: string[] }> {
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
  const encoded = disclosures.map((d) => d.encode());
  const decoySalts = opts.decoys ? padWithDecoys(packedClaims, encoded.length, salt) : [];
  return { payloadSd: packedClaims, disclosures: encoded, decoySalts };
}

/** A value with any object member possibly absent, as selective disclosure leaves it. */
export type Disclosed<T> = T extends readonly (infer U)[]
  ? Disclosed<U>[]
  : T extends object
    ? { [K in keyof T]?: Disclosed<T[K]> }
    : T;

/**
 * Rejects claims that would nest deeper than {@link MAX_DEPTH} once `disclosures` are applied,
 * before any recursion through them. Depth counts the arrays and objects around a value in the
 * result, and each digest is followed at most once.
 */
function assertDisclosedDepth(payload: object, disclosures: ReadonlyMap<string, unknown>): void {
  const seen = new Set<unknown>();
  const follow = (digest: unknown, depth: number) => {
    if (seen.has(digest)) return;
    seen.add(digest);
    if (typeof digest === "string" && disclosures.has(digest)) walk(disclosures.get(digest), depth);
  };
  const walk = (v: unknown, depth: number): void => {
    if (v === null || typeof v !== "object") return;
    if (depth >= MAX_DEPTH) throw new RangeError("disclosed claims nested too deep");
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item !== null && typeof item === "object" && "..." in item) {
          follow((item as Record<string, unknown>)["..."], depth + 1);
        } else walk(item, depth + 1);
      }
      return;
    }
    for (const [k, item] of Object.entries(v)) {
      if (k !== "_sd" || !Array.isArray(item)) walk(item, depth + 1);
      else for (const d of item) follow(d, depth + 1);
    }
  };
  walk(payload, 0);
}

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
  assertDisclosedDepth(payloadSd, new Map(decoded.map((d) => [d._digest as string, d.value])));
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
 * disclosures must be resolved by a disclosure or by one of `decoySalts`, and the result is
 * parsed with {@link parseMandate}.
 */
export function decodeMandate(
  payloadSd: object,
  disclosures: string[],
  decoySalts: readonly string[] = [],
): Mandate {
  const m = decodeDisclosed(payloadSd, disclosures);
  assertDigestsResolved(payloadSd, disclosures, decoySalts);
  return parseMandate(m);
}

/** What a merchant is shown of a mandate, for {@link merchantDisclosures}. */
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
