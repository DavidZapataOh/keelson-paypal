import type { Keelson } from "../client.ts";
import type { ConnectionRequestState } from "../types.ts";

export class Requests {
  private readonly keelson: Keelson;

  constructor(keelson: Keelson) {
    this.keelson = keelson;
  }

  /** A mandate request's state; reading it changes nothing. */
  async retrieve(requestId: string): Promise<ConnectionRequestState> {
    const path = `/v1/connections/requests/${encodeURIComponent(requestId)}`;
    return (await this.keelson.request<ConnectionRequestState>("GET", path)).data;
  }
}
