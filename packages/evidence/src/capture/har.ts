import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RecordedRequest } from "./recorder.ts";

const KEPT_HEADERS = ["cache-control", "content-type", "location"] as const;
const TEXT_TYPES = /^(application\/(?:[\w.+-]+\+)?json|text\/html)\b/i;
/** Bodies larger than this keep only their size and hash. */
export const MAX_HAR_BODY: number = 256 * 1024;

export interface HarEntry {
  request: { method: string; url: string };
  response: {
    status: number;
    headers: { name: string; value: string }[];
    content: { mimeType: string; size: number; text?: string; sha256?: string };
    _error?: string;
  };
}

export interface Har {
  log: { version: "1.2"; creator: { name: "keelson"; version: "1" }; entries: HarEntry[] };
}

/**
 * A HAR 1.2 log of the recorded requests, in the order they started, keeping only what is the
 * same on every load: no timings, dates, cookies, IP addresses or size estimates.
 */
export function buildHar(requests: readonly RecordedRequest[]): Har {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = requests.map((r): HarEntry => {
    const lower = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const headers = KEPT_HEADERS.filter((name) => lower.has(name)).map((name) => ({
      name,
      value: lower.get(name) as string,
    }));
    const mimeType = r.mimeType ?? "";
    const content: HarEntry["response"]["content"] = { mimeType, size: r.size };
    if (r.body && TEXT_TYPES.test(mimeType)) {
      let text: string | undefined;
      if (r.body.length <= MAX_HAR_BODY) {
        try {
          text = decoder.decode(r.body);
        } catch {
          text = undefined;
        }
      }
      if (text === undefined) content.sha256 = bytesToHex(sha256(r.body));
      else content.text = text;
    }
    const entry: HarEntry = {
      request: { method: r.method, url: r.url },
      response: { status: r.status ?? 0, headers, content },
    };
    if (r.failed) entry.response._error = r.failed;
    return entry;
  });
  return { log: { version: "1.2", creator: { name: "keelson", version: "1" }, entries } };
}
