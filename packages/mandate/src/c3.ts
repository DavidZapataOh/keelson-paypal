import { BN254_FR_MODULUS, poseidon2 } from "@keelson/core/poseidon2";
import { hSd, mandateChallenge } from "./challenge.ts";
import { type MandateOpening, mandateCommitment, mandateOpening } from "./commitment.ts";
import type { Mandate } from "./schema.ts";

/** Depth of the registered-user tree. */
export const USER_SET_DEPTH = 20;
/** The longest `clientDataJSON` the C3 circuit takes. */
export const C3_MAX_CLIENT_DATA = 1024;

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

/** A Poseidon2 Merkle tree of the registered users' key hashes, in registration order. */
export interface UserSet {
  readonly root: bigint;
  readonly leaves: readonly bigint[];
}

const LAYERS = new WeakMap<UserSet, bigint[][]>();
let zeroes: Promise<bigint[]> | undefined;

/** Roots of empty subtrees by height: `z_0 = 0`, `z_{h+1} = poseidon2([z_h, z_h])`. */
function zeroSubtrees(): Promise<bigint[]> {
  zeroes ??= (async () => {
    const z = [0n];
    for (let h = 0; h < USER_SET_DEPTH; h++) {
      z.push(await poseidon2([z[h] as bigint, z[h] as bigint]));
    }
    return z;
  })();
  return zeroes;
}

/**
 * The depth-{@link USER_SET_DEPTH} tree with `leaves` in slots `0…n-1` and zero elsewhere, inner
 * nodes `poseidon2([left, right])`. A leaf is a `user_key_hash`, which is never zero in practice.
 */
export async function userSet(leaves: readonly bigint[]): Promise<UserSet> {
  if (leaves.length > 2 ** USER_SET_DEPTH) throw new RangeError("too many users");
  const z = await zeroSubtrees();
  let layer = [...leaves];
  const layers = [layer];
  for (let h = 0; h < USER_SET_DEPTH; h++) {
    const next: bigint[] = [];
    for (let i = 0; i < layer.length; i += 2) {
      next.push(await poseidon2([layer[i] as bigint, layer[i + 1] ?? (z[h] as bigint)]));
    }
    layers.push(next);
    layer = next;
  }
  const set: UserSet = Object.freeze({
    root: layer[0] ?? (z[USER_SET_DEPTH] as bigint),
    leaves: Object.freeze([...leaves]),
  });
  LAYERS.set(set, layers);
  return set;
}

/** The siblings on the path from slot `index` to the root. */
export async function userPath(set: UserSet, index: number): Promise<bigint[]> {
  const layers = LAYERS.get(set);
  if (!layers) throw new TypeError("not a set built by userSet");
  if (!Number.isInteger(index) || index < 0 || index >= set.leaves.length) {
    throw new RangeError("no user at this index");
  }
  const z = await zeroSubtrees();
  return layers
    .slice(0, USER_SET_DEPTH)
    .map((layer, h) => layer[(index >> h) ^ 1] ?? (z[h] as bigint));
}

/** A WebAuthn or SPC assertion as `POST /v1/mandates` takes it: base64url fields, DER signature. */
export interface C3Assertion {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** The public inputs of a C3 proof, in circuit order. */
export interface C3Statement {
  cm: bigint;
  /** The passkey challenge `M`, read big-endian and reduced modulo the field. */
  mandateHash: bigint;
  userSetRoot: bigint;
  /** SHA-256 of the RP ID, read big-endian and reduced modulo the field. */
  rpIdHash: bigint;
}

/** The circuit's inputs in the Noir ABI's JSON form, and the statement they prove. */
export interface C3Inputs {
  inputs: Record<string, unknown>;
  statement: C3Statement;
}

const fromB64u = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toB64u = (b: Uint8Array): string =>
  btoa(String.fromCharCode(...b))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const hex = (x: bigint): string => `0x${x.toString(16).padStart(64, "0")}`;
const be = (bytes: Uint8Array): bigint => bytes.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
const bytes32 = (x: bigint): number[] =>
  Array.from({ length: 32 }, (_, i) => Number((x >> BigInt(8 * (31 - i))) & 0xffn));

/** `r ‖ s` of a DER ECDSA P-256 signature, with `s` replaced by `n - s` when it is high. */
function lowS(der: Uint8Array): number[] {
  const int = (at: number): [bigint, number] => {
    if (der[at] !== 0x02) throw new TypeError("malformed DER signature");
    const n = der[at + 1] as number;
    return [be(der.subarray(at + 2, at + 2 + n)), at + 2 + n];
  };
  if (der[0] !== 0x30 || der[1] !== der.length - 2) throw new TypeError("malformed DER signature");
  const [r, next] = int(2);
  const [s, end] = int(next);
  if (end !== der.length || r >= P256_N || s >= P256_N) {
    throw new TypeError("malformed DER signature");
  }
  return [...bytes32(r), ...bytes32(s > P256_N / 2n ? P256_N - s : s)];
}

function indexOf(haystack: Uint8Array, needle: string): number {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= haystack.length; i++) {
    for (let j = 0; j < n.length; j++) if (haystack[i + j] !== n[j]) continue outer;
    return i;
  }
  throw new RangeError(`clientDataJSON has no ${needle}`);
}

const openingInputs = (o: MandateOpening) => ({
  max_amount: o.maxAmount.toString(),
  currency: o.currency.toString(),
  category_mask: o.categoryMask.toString(),
  merchant_root: hex(o.merchantRoot),
  expiry: o.expiry.toString(),
  operator_id: hex(o.operatorId),
  nonce: hex(o.nonce),
  salt: hex(o.salt),
});

/**
 * The C3 `anonymous_mandate` inputs for the user of `mandate`, who signed it with `assertion`
 * under the commitment salt `salt`, as a member of `users`.
 */
export async function c3Inputs(args: {
  mandate: Mandate;
  salt: Uint8Array;
  payloadSd: object;
  assertion: C3Assertion;
  users: UserSet;
}): Promise<C3Inputs> {
  const { mandate, salt, payloadSd, assertion, users } = args;
  const [o, cm] = await Promise.all([
    mandateOpening(mandate, salt),
    mandateCommitment(mandate, salt),
  ]);
  const index = users.leaves.indexOf(o.userKeyHash);
  if (index < 0) throw new RangeError("the mandate's passkey is not a registered user");
  const h = hSd(payloadSd);
  const clientData = fromB64u(assertion.clientDataJSON);
  const authData = fromB64u(assertion.authenticatorData);
  if (authData.length !== 37) throw new RangeError("authenticator data is not 37 bytes");
  if (clientData.length > C3_MAX_CLIENT_DATA) throw new RangeError("clientDataJSON is too long");
  const challengeIndex = indexOf(clientData, '"challenge":"');
  const signed = new TextDecoder().decode(clientData.subarray(challengeIndex));
  const m = mandateChallenge(h, cm);
  if (!signed.startsWith(`"challenge":"${toB64u(m)}"`)) {
    throw new RangeError("the assertion is not over this mandate's challenge");
  }
  const rpIdHash = be(authData.subarray(0, 32)) % BN254_FR_MODULUS;
  const mandateHash = be(m) % BN254_FR_MODULUS;
  const storage = new Array<number>(C3_MAX_CLIENT_DATA).fill(0);
  storage.splice(0, clientData.length, ...clientData);
  const { x, y } = mandate.user.cred.jwk;
  return {
    inputs: {
      c_m: hex(cm),
      mandate_hash: hex(mandateHash),
      user_set_root: hex(users.root),
      rp_id_hash: hex(rpIdHash),
      key_x: Array.from(fromB64u(x)),
      key_y: Array.from(fromB64u(y)),
      h_sd: Array.from(h),
      opening: openingInputs(o),
      user_index: String(index),
      user_path: (await userPath(users, index)).map(hex),
      assertion: {
        signature: lowS(fromB64u(assertion.signature)),
        authenticator_data: Array.from(authData),
        client_data_json: { storage, len: String(clientData.length) },
        challenge_index: String(challengeIndex),
        type_index: String(indexOf(clientData, '"type":"')),
      },
    },
    statement: { cm, mandateHash, userSetRoot: users.root, rpIdHash },
  };
}
