import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { type Validity, within } from "./validity.ts";

interface Entry<T> {
  value: T;
  validity: Validity;
}

/**
 * Platform verifications that passed, each reused only for a verification time at which every
 * certificate, CRL and collateral item it checked is still current. Its key covers every byte of
 * the attestation (evidence, binding and block) and the measurement allowlist; failures are not
 * kept.
 */
export class AttestationCache {
  readonly #entries = new Map<string, Entry<unknown>>();

  constructor(readonly max = 64) {}

  /** The key of `evidence` verified against `measurements`. */
  static key(evidence: unknown, measurements: readonly string[]): string {
    return bytesToHex(sha256(utf8ToBytes(JSON.stringify([evidence, [...measurements].sort()]))));
  }

  /** @internal */
  get<T>(key: string, at: Date): T | undefined {
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    if (within(entry.validity, at)) return entry.value as T;
    return undefined;
  }

  /** @internal */
  set<T>(key: string, value: T, validity: Validity): void {
    this.#entries.delete(key);
    this.#entries.set(key, { value, validity });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= this.max) break;
      this.#entries.delete(oldest);
    }
  }
}
