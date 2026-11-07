import { sha256 } from "@keelson/core";
import { ed25519 } from "@noble/curves/ed25519.js";
import { ml_dsa44 } from "@noble/post-quantum/ml-dsa.js";

const encoder = new TextEncoder();

/** A checkpoint (c2sp.org/tlog-checkpoint) whose signatures verified. */
export interface VerifiedCheckpoint {
  origin: string;
  size: bigint;
  root: Uint8Array;
}

function fromBase64(s: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new TypeError("malformed base64");
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

const equal = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v);
  return b;
};

/** A c2sp.org/signed-note verifier key: Ed25519 (0x01) or ML-DSA-44 (0x06). */
interface Vkey {
  name: string;
  hash: Uint8Array;
  alg: number;
  key: Uint8Array;
}

function parseVkey(vkey: string): Vkey {
  const m = /^([^+\s]+)\+([0-9a-f]{8})\+([A-Za-z0-9+/=]+)$/.exec(vkey.trim());
  if (!m) throw new TypeError("malformed vkey");
  const [, name, hash, key64] = m as unknown as [string, string, string, string];
  const raw = fromBase64(key64);
  const alg = raw[0];
  const key = raw.subarray(1);
  if (!((alg === 0x01 && key.length === 32) || (alg === 0x06 && key.length === 1312))) {
    throw new TypeError("unsupported vkey algorithm");
  }
  const digest = sha256(concat(encoder.encode(`${name}\n`), raw));
  if (
    !equal(
      digest.subarray(0, 4),
      Uint8Array.from(hash.match(/../g) ?? [], (h) => parseInt(h, 16)),
    )
  ) {
    throw new TypeError("vkey hash does not match its key");
  }
  return { name, hash: digest.subarray(0, 4), alg, key };
}

/** The `subtree/v1` message an ML-DSA-44 log signature covers (c2sp.org/tlog-cosignature). */
function subtreeMessage(name: string, time: bigint, cp: VerifiedCheckpoint): Uint8Array {
  const n = encoder.encode(name);
  const o = encoder.encode(cp.origin);
  return concat(
    encoder.encode("subtree/v1\n\0"),
    Uint8Array.of(n.length),
    n,
    u64(time),
    Uint8Array.of(o.length),
    o,
    u64(0n),
    u64(cp.size),
    cp.root,
  );
}

/**
 * Verifies a signed checkpoint and requires a valid signature from every vkey, each named
 * after the checkpoint's origin.
 */
export function verifyCheckpoint(signed: string, vkeys: readonly string[]): VerifiedCheckpoint {
  const split = signed.indexOf("\n\n");
  if (split < 0) throw new TypeError("malformed note");
  const text = signed.slice(0, split + 1);
  const lines = text.split("\n");
  const [origin, size, root64] = lines;
  if (!origin || !size || !/^(0|[1-9][0-9]*)$/.test(size) || !root64) {
    throw new TypeError("malformed checkpoint");
  }
  const cp: VerifiedCheckpoint = { origin, size: BigInt(size), root: fromBase64(root64) };
  if (cp.root.length !== 32) throw new TypeError("malformed checkpoint root");
  const sigs = signed
    .slice(split + 2)
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const m = /^— (\S+) ([A-Za-z0-9+/=]+)$/.exec(l);
      if (!m) throw new TypeError("malformed signature line");
      return { name: m[1] as string, sig: fromBase64(m[2] as string) };
    });
  if (vkeys.length === 0) throw new TypeError("no verifier keys");
  for (const vkey of vkeys.map(parseVkey)) {
    if (vkey.name !== origin) throw new Error(`vkey ${vkey.name} is not for ${origin}`);
    const ok = sigs.some(({ name, sig }) => {
      if (name !== vkey.name || !equal(sig.subarray(0, 4), vkey.hash)) return false;
      if (vkey.alg === 0x01) {
        return ed25519.verify(sig.subarray(4), encoder.encode(text), vkey.key, { zip215: false });
      }
      if (sig.length !== 4 + 8 + 2420 || lines.length !== 4) return false;
      const time = new DataView(sig.buffer, sig.byteOffset + 4, 8).getBigUint64(0);
      return ml_dsa44.verify(sig.subarray(12), subtreeMessage(vkey.name, time, cp), vkey.key);
    });
    if (!ok) throw new Error(`the checkpoint is not signed by ${vkey.name}+${vkey.alg}`);
  }
  return cp;
}

const nodeHash = (l: Uint8Array, r: Uint8Array) => sha256(concat(Uint8Array.of(1), l, r));

/** RFC 9162 §2.1.3.2: the root an inclusion proof gives for `leaf` at `index` of `size`. */
function inclusionRoot(index: bigint, size: bigint, leaf: Uint8Array, proof: Uint8Array[]) {
  if (index >= size) throw new RangeError("index is outside the tree");
  let fn = index;
  let sn = size - 1n;
  let r = leaf;
  for (const p of proof) {
    if (sn === 0n) throw new Error("the inclusion proof is too long");
    if ((fn & 1n) === 1n || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1n) === 0n) {
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  if (sn !== 0n) throw new Error("the inclusion proof is too short");
  return r;
}

/**
 * Verifies a c2sp.org/tlog-proof@v1 for the RFC 6962 `leafHash`: the inclusion proof leads to
 * the root of a checkpoint every vkey signed. Returns the index and the checkpoint.
 */
export function verifyProof(
  proof: string,
  leafHash: Uint8Array,
  vkeys: readonly string[],
): { index: bigint; checkpoint: VerifiedCheckpoint } {
  const m = /^c2sp\.org\/tlog-proof@v1\n(?:extra [A-Za-z0-9+/=]*\n)?index (0|[1-9][0-9]*)\n/.exec(
    proof,
  );
  if (!m) throw new TypeError("malformed tlog proof");
  let rest = proof.slice(m[0].length);
  const hashes: Uint8Array[] = [];
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl < 0) throw new TypeError("malformed tlog proof");
    const line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line === "") break;
    const h = fromBase64(line);
    if (h.length !== 32) throw new TypeError("malformed tlog proof hash");
    hashes.push(h);
  }
  const index = BigInt(m[1] as string);
  const checkpoint = verifyCheckpoint(rest, vkeys);
  if (!equal(inclusionRoot(index, checkpoint.size, leafHash, hashes), checkpoint.root)) {
    throw new Error("the leaf is not included in the checkpoint");
  }
  return { index, checkpoint };
}
