import type { Keelson } from "../client.ts";
import type { Operator, TrustGrade } from "../types.ts";

export class Operators {
  constructor(private readonly keelson: Keelson) {}

  /** Links your ERC-8004 agent to this OAuth client, so mandates can name it. */
  async link(o: {
    chainId: 421614 | 42161 | 11155111;
    agentId: string;
    name: string;
    cnfJwk: { kty: "EC"; crv: "P-256"; x: string; y: string; kid?: string };
  }): Promise<Operator> {
    return (await this.keelson.request<Operator>("POST", "/v1/operators", { body: o })).data;
  }

  /** The operator's public trust grade, from its covered purchases and incidents. */
  async grade(agentId: string): Promise<TrustGrade> {
    const path = `/v1/operators/${encodeURIComponent(agentId)}/grade`;
    return (await this.keelson.request<TrustGrade>("GET", path, { auth: false })).data;
  }

  /** Tells the mandate's owner the agent started or ended a run, with its read-only live view. */
  async announceRun(
    agentId: string,
    mandateId: string,
    o: { state: "started" | "ended"; liveViewUrl?: string },
  ): Promise<void> {
    const path = `/v1/operators/${encodeURIComponent(agentId)}/mandates/${encodeURIComponent(mandateId)}/runs`;
    await this.keelson.request("POST", path, { body: o, as: "none" });
  }
}
