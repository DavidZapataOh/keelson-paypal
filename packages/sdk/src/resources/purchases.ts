import { closeMandate } from "../agent-key.ts";
import type { Keelson } from "../client.ts";
import {
  APIConnectionError,
  ConflictError,
  InternalServerError,
  KeelsonError,
  OutcomeUnknownError,
} from "../errors.ts";
import { paypalValue } from "../money.ts";
import type { Cart, Countersigned, Purchase } from "../types.ts";
import type { Mandate } from "./mandates.ts";

/** Crockford base32 ULID, the purchase's id. */
function ulid(): string {
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = Date.now();
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = A[time % 32] + out;
    time = Math.floor(time / 32);
  }
  for (const b of crypto.getRandomValues(new Uint8Array(16))) out += A[b % 32];
  return out;
}

/** What a countersign answered. */
export interface CountersignResult {
  purchaseId: string;
  /** `null` while the cart waits for the user's one-time approval. */
  decision: "allow" | "deny" | null;
  /** The cart is above the user's ask-me amount: send them here, then countersign again. */
  approval: { requestId: string; approvalUrl: string } | null;
  /** This cart was already bought; this is that purchase. */
  existing: boolean;
  countersigned: Countersigned | null;
}

const PENDING = new Set(["PROPOSED", "EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"]);

export class Purchases {
  private readonly keelson: Keelson;
  private readonly agentKey: () => Promise<CryptoKey | undefined>;

  constructor(keelson: Keelson, agentKey: () => Promise<CryptoKey | undefined>) {
    this.keelson = keelson;
    this.agentKey = agentKey;
  }

  /**
   * Asks Keelson's two TEEs to countersign the cart under the mandate, with the sealed evidence.
   * On allow the purchase is logged, covered by the operator's bond and captured on PayPal.
   * Safe to call again after an error: the same cart under the same mandate is one purchase.
   * When the answer is lost it raises {@link OutcomeUnknownError}; read the outcome with
   * {@link waitFor}, never send it again.
   */
  async countersign(o: {
    mandate: Mandate;
    evidenceRoot: string;
    cart: Cart;
    /** Only to buy this same cart again on purpose: the purchase of it you got last. */
    repeatOf?: string;
  }): Promise<CountersignResult> {
    const { mandate, cart } = o;
    if (mandate.holdMode !== "mandate" || !mandate.authorizationId) {
      throw new KeelsonError(
        "This mandate holds each purchase separately; use one held as a whole.",
      );
    }
    const requestId = ulid();
    const key = await this.agentKey();
    const authority = key
      ? { closedMandate: await closeMandate(mandate.openMandate, { requestId, cart }, key) }
      : { mandateId: mandate.id, requestId };
    const total = cart.lines.reduce((sum, l) => sum + l.qty * l.unit_minor, 0);
    const value = paypalValue(cart.currency, total);
    try {
      const { data } = await this.keelson.request<Countersigned & { approval?: Approval }>(
        "POST",
        "/v1/countersign",
        {
          body: {
            authorizationId: mandate.authorizationId,
            ...authority,
            cart,
            unit: {
              amount: {
                currency_code: cart.currency,
                value,
                breakdown: { item_total: { currency_code: cart.currency, value } },
              },
            },
            evidenceRoot: o.evidenceRoot,
            ...(o.repeatOf ? { repeatOf: o.repeatOf } : {}),
          },
        },
      );
      return {
        purchaseId: data.purchaseId ?? requestId,
        decision: data.decision,
        approval: approvalOf(data.approval),
        existing: false,
        countersigned: data,
      };
    } catch (err) {
      if (err instanceof ConflictError && err.type === "purchase-exists") {
        return {
          purchaseId: err.problem.purchaseId as string,
          decision: null,
          approval: null,
          existing: true,
          countersigned: null,
        };
      }
      if (err instanceof ConflictError && err.type === "approval-required") {
        return {
          purchaseId: "",
          decision: null,
          approval: approvalOf(err.problem.approval as Approval),
          existing: false,
          countersigned: null,
        };
      }
      if (err instanceof APIConnectionError || err instanceof InternalServerError) {
        throw new OutcomeUnknownError(requestId, { cause: err });
      }
      throw err;
    }
  }

  async retrieve(purchaseId: string): Promise<Purchase> {
    const path = `/v1/purchases/${encodeURIComponent(purchaseId)}`;
    return (await this.keelson.request<Purchase>("GET", path)).data;
  }

  /** Waits until the purchase is captured, denied or failed. */
  async waitFor(
    purchaseId: string,
    o: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<Purchase> {
    const until = Date.now() + (o.timeoutMs ?? 120_000);
    for (;;) {
      const p = await this.retrieve(purchaseId).catch((err: unknown) => {
        // A purchase whose countersign is still in flight may not be readable yet.
        if (err instanceof KeelsonError && "status" in err && err.status === 404) return undefined;
        throw err;
      });
      if (p && !PENDING.has(p.state)) return p;
      if (Date.now() > until) {
        throw new KeelsonError(`Purchase ${purchaseId} is still ${p?.state ?? "unknown"}.`);
      }
      await new Promise((r) => setTimeout(r, 1000));
      o.signal?.throwIfAborted();
    }
  }
}

interface Approval {
  request_id?: string;
  verification_uri_complete?: string;
}

function approvalOf(a: Approval | undefined): CountersignResult["approval"] {
  return a?.request_id && a.verification_uri_complete
    ? { requestId: a.request_id, approvalUrl: a.verification_uri_complete }
    : null;
}
