import type { Keelson } from "../client.ts";
import { MandateRequestClosedError } from "../errors.ts";
import { type Amount, isoOf, minorOf, type Until } from "../money.ts";
import type { Cart, CartCheck, DeviceAuthorization, OperatorMandate } from "../types.ts";

/** A request the user approves on Keelson's page with a passkey. */
export interface MandateRequest {
  id: string;
  /** Send the user here; it is also printed by `npx keelson` tools. */
  approvalUrl: string;
  userCode: string;
  /** Show it beside the link: the user picks it out of three. `null` when you act as the user. */
  matchNumber: number | null;
  expiresAt: string;
  /** Seconds between reads of the request's state. */
  interval: number;
}

/** An active mandate the agent may buy under, with the operator it names. */
export type Mandate = OperatorMandate & { agentId: string };

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

function requestOf(d: DeviceAuthorization): MandateRequest {
  return {
    id: d.request_id,
    approvalUrl: d.verification_uri_complete,
    userCode: d.user_code,
    matchNumber: d.match_number ?? null,
    expiresAt: new Date(Date.now() + d.expires_in * 1000).toISOString(),
    interval: d.interval,
  };
}

export class Mandates {
  private readonly keelson: Keelson;

  constructor(keelson: Keelson) {
    this.keelson = keelson;
  }

  /**
   * Asks the user to let the agent spend within limits. They approve on Keelson's page with a
   * passkey and may lower any limit.
   */
  async request(o: {
    /** How the user knows this agent, e.g. `Claude Code`. */
    name: string;
    /** Why you ask, in at least 100 characters; the user reads it before approving. */
    reason: string;
    perPurchase: Amount;
    total: Amount;
    /** When the mandate ends: keep it short. */
    until: Until;
    /** Above this, the user approves each purchase. */
    askAbove?: Amount;
  }): Promise<MandateRequest> {
    const per = minorOf(o.perPurchase);
    const total = minorOf(o.total);
    const { data } = await this.keelson.request<DeviceAuthorization>("POST", "/v1/connections", {
      body: {
        name: o.name,
        reason: o.reason,
        limits: {
          currency: total.currency,
          perPurchaseMinor: per.minor,
          totalMinor: total.minor,
          until: isoOf(o.until),
          ...(o.askAbove === undefined ? {} : { askAboveMinor: minorOf(o.askAbove).minor }),
        },
      },
    });
    return requestOf(data);
  }

  /** Asks the user to change a mandate's limits, with a one-line note they read. */
  async requestChange(
    mandateId: string,
    o: { note: string; perPurchase?: Amount; total?: Amount; until?: Until; askAbove?: Amount },
  ): Promise<MandateRequest> {
    const limits = {
      ...(o.perPurchase === undefined ? {} : { perPurchaseMinor: minorOf(o.perPurchase).minor }),
      ...(o.total === undefined ? {} : { totalMinor: minorOf(o.total).minor }),
      ...(o.until === undefined ? {} : { until: isoOf(o.until) }),
      ...(o.askAbove === undefined ? {} : { askAboveMinor: minorOf(o.askAbove).minor }),
    };
    const { data } = await this.keelson.request<DeviceAuthorization>(
      "POST",
      `/v1/mandates/${encodeURIComponent(mandateId)}/changes`,
      { body: { note: o.note, ...(Object.keys(limits).length ? { limits } : {}) } },
    );
    return requestOf(data);
  }

  /** The active mandates naming the operator, newest first. */
  async list(agentId: string): Promise<Mandate[]> {
    const { data } = await this.keelson.request<{ mandates: OperatorMandate[] }>(
      "GET",
      `/v1/operators/${encodeURIComponent(agentId)}/mandates`,
    );
    return data.mandates.map((m) => ({ ...m, agentId }));
  }

  /**
   * Waits for the user's answer and for the mandate's PayPal hold, then returns the mandate.
   * A decline or an expiry raises {@link MandateRequestClosedError}.
   */
  async waitForApproval(
    requestId: string,
    o: { signal?: AbortSignal; timeoutMs?: number; onPending?: () => void } = {},
  ): Promise<Mandate> {
    const until = Date.now() + (o.timeoutMs ?? 15 * 60_000);
    for (;;) {
      const state = await this.keelson.requests.retrieve(requestId);
      if (state.state === "DENIED" || state.state === "EXPIRED") {
        throw new MandateRequestClosedError(state.state);
      }
      if (state.state === "APPROVED" && state.mandateId) {
        const mandate = (await this.list(state.operatorAgentId)).find(
          (m) => m.id === state.mandateId,
        );
        if (mandate && (mandate.holdMode === "per_purchase" || mandate.authorizationId)) {
          return mandate;
        }
      }
      if (Date.now() > until) throw new MandateRequestClosedError("EXPIRED");
      o.onPending?.();
      await sleep(Math.max(state.interval, 1) * 1000, o.signal);
    }
  }

  /** Whether a countersign of this cart would pass the mandate as it stands, and why not. */
  async check(mandateId: string, cart: Cart): Promise<CartCheck> {
    const path = `/v1/mandates/${encodeURIComponent(mandateId)}/check`;
    return (await this.keelson.request<CartCheck>("POST", path, { body: { cart } })).data;
  }
}
