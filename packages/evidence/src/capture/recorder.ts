import { Buffer } from "node:buffer";
import type { CDPSession, Page } from "playwright";

/** A request seen on the tab, with its response and, for JSON and HTML, its body. */
export interface RecordedRequest {
  method: string;
  url: string;
  status?: number;
  headers?: Record<string, string>;
  mimeType?: string;
  /** Decoded body bytes received. */
  size: number;
  body?: Uint8Array;
  failed?: string;
}

/** Records the tab's network traffic from the moment the agent opens it. */
export interface Recorder {
  readonly page: Page;
  readonly session: CDPSession;
  readonly requests: readonly RecordedRequest[];
  /** Resolves once every response body requested so far has been read. */
  settled(): Promise<void>;
  stop(): Promise<void>;
}

const BODY_TYPES = /^(application\/(?:[\w.+-]+\+)?json|text\/html)\b/i;

/**
 * Attaches a CDP session to the page and starts recording its network events. Call it before
 * the first navigation so the document request is recorded too.
 */
export async function startRecorder(page: Page): Promise<Recorder> {
  const session = await page.context().newCDPSession(page);
  const requests: RecordedRequest[] = [];
  const live = new Map<string, RecordedRequest>();
  const reads = new Set<Promise<void>>();

  session.on("Network.requestWillBeSent", (e) => {
    const previous = live.get(e.requestId);
    if (previous && e.redirectResponse) {
      previous.status = e.redirectResponse.status;
      previous.headers = e.redirectResponse.headers;
      previous.mimeType = e.redirectResponse.mimeType;
    }
    if (e.request.url.startsWith("data:")) {
      live.delete(e.requestId);
      return;
    }
    const entry: RecordedRequest = { method: e.request.method, url: e.request.url, size: 0 };
    requests.push(entry);
    live.set(e.requestId, entry);
  });
  session.on("Network.responseReceived", (e) => {
    const entry = live.get(e.requestId);
    if (!entry) return;
    entry.status = e.response.status;
    entry.headers = e.response.headers;
    entry.mimeType = e.response.mimeType;
  });
  session.on("Network.dataReceived", (e) => {
    const entry = live.get(e.requestId);
    if (entry) entry.size += e.dataLength;
  });
  session.on("Network.loadingFailed", (e) => {
    const entry = live.get(e.requestId);
    if (entry) entry.failed = e.errorText;
    live.delete(e.requestId);
  });
  session.on("Network.loadingFinished", (e) => {
    const entry = live.get(e.requestId);
    live.delete(e.requestId);
    if (!entry || !BODY_TYPES.test(entry.mimeType ?? "")) return;
    const read = session
      .send("Network.getResponseBody", { requestId: e.requestId })
      .then(({ body, base64Encoded }) => {
        entry.body = base64Encoded
          ? Uint8Array.from(Buffer.from(body, "base64"))
          : new TextEncoder().encode(body);
        entry.size = entry.body.length;
      })
      .catch(() => {
        // The body was evicted or the target closed; the entry keeps its size.
      })
      .finally(() => {
        reads.delete(read);
      });
    reads.add(read);
  });
  await session.send("Network.enable");

  return {
    page,
    session,
    requests,
    async settled() {
      while (reads.size > 0) await Promise.all(reads);
    },
    async stop() {
      await session.detach();
    },
  };
}
