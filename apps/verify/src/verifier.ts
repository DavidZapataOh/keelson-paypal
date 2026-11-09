import type { ChainAnswer, ChainReader } from "@keelson/alibi/verify";

/** The verifier, loading from the moment the page does, before anything is dropped. */
export const verifier = import("@keelson/alibi/verify");

const keyOf = (v: unknown) =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

/** A chain reader that answers an identical query once, so edits re-verify without the network. */
export function memoized(inner: ChainReader): ChainReader {
  const cache = new Map<string, Promise<ChainAnswer>>();
  return {
    read(chainId, q) {
      const key = keyOf([chainId, q]);
      let answer = cache.get(key);
      if (!answer) {
        answer = inner.read(chainId, q);
        cache.set(key, answer);
        answer.catch(() => cache.delete(key));
      }
      return answer;
    },
  };
}

/** The input readers, which carry the Alibi schema; loaded with the verifier. */
export const loader = import("./load.ts");
