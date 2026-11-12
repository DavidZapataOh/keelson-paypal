import type { Keelson } from "../client.ts";

export interface ServerEvent {
  id: string | null;
  event: string;
  data: string;
}

/** Parses a `text/event-stream` body (HTML Living Standard §9.2.6). */
async function* parse(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event: ServerEvent = { id: null, event: "message", data: "" };
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.search(/\r\n|\r|\n/);
    while (nl >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") {
        if (data.length) yield { ...event, data: data.join("\n") };
        event = { id: event.id, event: "message", data: "" };
        data = [];
      } else if (!line.startsWith(":")) {
        const colon = line.indexOf(":");
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "event") event.event = value;
        else if (field === "id") event.id = value;
      }
      nl = buffer.search(/\r\n|\r|\n/);
    }
  }
}

export class Events {
  private readonly keelson: Keelson;

  constructor(keelson: Keelson) {
    this.keelson = keelson;
  }

  /**
   * Live events of a channel: `public:<name>`, or your own namespace. Reconnects after a drop and
   * resumes after the last event it saw (`Last-Event-ID`).
   */
  async *stream(
    channel: string,
    o: { lastEventId?: string; signal?: AbortSignal } = {},
  ): AsyncGenerator<ServerEvent> {
    let last = o.lastEventId;
    for (let failures = 0; !o.signal?.aborted; ) {
      try {
        const { response } = await this.keelson.request("GET", "/v1/events", {
          query: { channel },
          headers: last ? { "last-event-id": last } : {},
          as: "stream",
          ...(o.signal ? { signal: o.signal } : {}),
        });
        if (!response.body) return;
        for await (const e of parse(response.body)) {
          failures = 0;
          if (e.id) last = e.id;
          yield e;
        }
      } catch (err) {
        if (o.signal?.aborted || ++failures > 5) throw err;
      }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, Math.min(500 * 2 ** failures, 8_000));
        o.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(o.signal?.reason);
          },
          { once: true },
        );
      });
    }
  }
}
