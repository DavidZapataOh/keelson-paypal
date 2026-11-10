import { arbitrumSepolia } from "viem/chains";
import { type ChainAnswer, type ChainReader, createChainReader } from "../src/verify/index.ts";

const rpc = process.env.ARBITRUM_SEPOLIA_RPC_URL;

/** The chain reader of the live tests: the CI's RPC when it is set, else the public defaults. */
export const liveChain = (): ChainReader =>
  createChainReader(rpc ? { rpc: { 421614: [rpc, ...arbitrumSepolia.rpcUrls.default.http] } } : {});

const keyOf = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

/** Answers an identical chain query once, so thousands of edits stay within the RPC's limits. */
export function memoized(inner: ChainReader): ChainReader {
  const cache = new Map<string, Promise<ChainAnswer>>();
  return {
    read(chainId, q) {
      const key = keyOf([chainId, q]);
      let answer = cache.get(key);
      if (!answer) {
        answer = inner.read(chainId, q);
        cache.set(key, answer);
      }
      return answer;
    },
  };
}

const HEX = "0123456789abcdef";
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * The last letter or digit of `s` outside PEM armor, rotated within its alphabet: hex stays hex,
 * and base64 moves 16 places so that a character next to `=` padding still changes a decoded bit.
 */
function rotate(s: string): string {
  const masked = s.replace(/-----[A-Z0-9 ]+-----/g, (l) => "-".repeat(l.length));
  const m = /[A-Za-z0-9](?=[^A-Za-z0-9]*$)/.exec(masked);
  if (!m)
    return s === ""
      ? "x"
      : `${s.slice(0, -1)}${String.fromCharCode(s.charCodeAt(s.length - 1) ^ 1)}`;
  const c = s[m.index] as string;
  const next = /^(0x)?[0-9a-fA-F]+$/.test(s)
    ? HEX[(HEX.indexOf(c.toLowerCase()) + 1) % 16]
    : ALNUM[(ALNUM.indexOf(c) + 16) % ALNUM.length];
  return `${s.slice(0, m.index)}${next}${s.slice(m.index + 1)}`;
}

/** Another value of the same kind; an empty array or object gains one member. */
export function mutate(v: unknown): unknown {
  if (typeof v === "string") return rotate(v);
  if (typeof v === "number") return v + 1;
  if (typeof v === "boolean") return !v;
  if (v === null) return 0;
  return Array.isArray(v) ? [0] : { x: 0 };
}

/** Sets the value at an RFC 6901 pointer that exists. */
export function setAt(e: unknown, p: string, v: unknown): void {
  const keys = p
    .slice(1)
    .split("/")
    .map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
  let o = e as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>;
  o[keys.at(-1) as string] = v;
}
