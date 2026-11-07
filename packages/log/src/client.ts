import { hexToBytes } from "@noble/hashes/utils.js";

/** The public host every origin is served under. */
export const LOG_HOST = "log.keelson.finance";

/** The log origin of each chain the Countersign domain may name. */
export const LOG_ORIGINS: Readonly<Record<number, string>> = {
  421614: `${LOG_HOST}/alibi/2026-1`,
  42161: `${LOG_HOST}/alibi-live/2026-1`,
};

export interface AppendResult {
  index: bigint;
  /** RFC 6962 leaf hash. */
  leafHash: Uint8Array;
  /** c2sp.org/tlog-proof@v1 against `checkpoint`. */
  proof: string;
  checkpoint: string;
}

export type LogErrorKind = "rejected" | "pushback" | "timeout" | "unreachable";

export class LogError extends Error {
  readonly kind: LogErrorKind;
  readonly code: string | undefined;

  constructor(kind: LogErrorKind, code?: string) {
    super(code ? `log ${kind}: ${code}` : `log ${kind}`);
    this.name = "LogError";
    this.kind = kind;
    this.code = code;
  }
}

/** Appends leaves to one origin of the log over its private write listener. */
export class LogClient {
  private readonly endpoint: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(url: string, token: string, origin: string, timeoutMs = 5000) {
    if (!origin.startsWith(`${LOG_HOST}/`)) throw new RangeError(`not a log origin: ${origin}`);
    this.endpoint = `${url.replace(/\/$/, "")}/${origin.slice(LOG_HOST.length + 1)}/add`;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  /** Appends `leaf` and resolves once a checkpoint covers it. */
  async add(leaf: Uint8Array, countersign: Record<string, string>): Promise<AppendResult> {
    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: JSON.stringify({ leaf: btoa(String.fromCharCode(...leaf)), countersign }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      throw new LogError(
        name === "TimeoutError" || name === "AbortError" ? "timeout" : "unreachable",
      );
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, string>;
    if (res.status === 200) {
      const { index, leafHash, proof, checkpoint } = body;
      if (!index || !leafHash || !proof || !checkpoint)
        throw new LogError("unreachable", "malformed");
      return { index: BigInt(index), leafHash: hexToBytes(leafHash), proof, checkpoint };
    }
    if (res.status === 429) throw new LogError("pushback");
    if (res.status === 503) throw new LogError("timeout", body.code);
    if (res.status >= 400 && res.status < 500) throw new LogError("rejected", body.code);
    throw new LogError("unreachable", String(res.status));
  }
}
