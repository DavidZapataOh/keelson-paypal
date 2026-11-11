import type { Keelson } from "../client.ts";
import { type EvidenceSources, manifestOf, sealedItems } from "../seal.ts";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export class Evidence {
  constructor(private readonly keelson: Keelson) {}

  /**
   * Seals what the agent saw when it chose the cart: each item gets its own salt, and only the
   * manifest's root is ever public. Returns the `evidenceRoot` to countersign with.
   */
  async seal(o: { mandateId: string; sources: EvidenceSources }): Promise<{
    evidenceRoot: string;
    items: string[];
  }> {
    const items = sealedItems(o.sources);
    const { data } = await this.keelson.request<{ evidenceRoot: string }>("POST", "/v1/evidence", {
      body: {
        mandateId: o.mandateId,
        manifest: manifestOf(items),
        items: items.map((i) => ({
          type: i.type,
          mediaType: i.mediaType,
          salt: b64(i.salt),
          bytes: b64(i.bytes),
        })),
      },
    });
    return { evidenceRoot: data.evidenceRoot, items: items.map((i) => i.type) };
  }
}
