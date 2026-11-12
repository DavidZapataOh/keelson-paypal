import type { Keelson } from "../client.ts";
import type { AlibiReceipt, AlibiReport } from "../types.ts";

const ALIBI = "application/vnd.keelson.alibi.v1+json";

export class Alibis {
  private readonly keelson: Keelson;

  constructor(keelson: Keelson) {
    this.keelson = keelson;
  }

  /**
   * The purchase's Alibi as issued: RFC 8785 JSON bytes, ready for `verifyAlibi`. Your own
   * purchases' Alibis need your credentials; a live purchase's Alibi is public.
   */
  async retrieve(purchaseId: string): Promise<Uint8Array> {
    const path = `/v1/alibis/${encodeURIComponent(purchaseId)}`;
    return (await this.keelson.request<Uint8Array>("GET", path, { as: "bytes", auth: "optional" }))
      .data;
  }

  /** What the public log already publishes about the Alibi: leaf, inclusion proof, anchor. */
  async receipt(purchaseId: string): Promise<AlibiReceipt> {
    const path = `/v1/alibis/${encodeURIComponent(purchaseId)}/receipt`;
    return (await this.keelson.request<AlibiReceipt>("GET", path, { auth: false })).data;
  }

  /** The Alibi as a PDF/A-3 with the bundle attached. */
  async pdf(purchaseId: string): Promise<Uint8Array> {
    const path = `/v1/alibis/${encodeURIComponent(purchaseId)}.pdf`;
    return (await this.keelson.request<Uint8Array>("GET", path, { as: "bytes", auth: "optional" }))
      .data;
  }

  /** Keelson's own check of an Alibi. To trust no one, use `verifyAlibi` from `@keelson-finance/verifier`. */
  async verifyRemote(alibi: Uint8Array): Promise<AlibiReport> {
    return (
      await this.keelson.request<AlibiReport>("POST", "/v1/alibis/verify", {
        body: alibi,
        headers: { "content-type": ALIBI },
        auth: false,
      })
    ).data;
  }
}
