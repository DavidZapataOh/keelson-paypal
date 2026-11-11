import {
  type Cart,
  type CurrencyCode,
  cartHash,
  toHex,
  toPayPalValue,
} from "@keelson/core";
import { buildManifest, canonicalBytes, MEDIA_TYPES, type SealedItem } from "@keelson/evidence";
import { closeMandate } from "@keelson/mandate";
import { ulid } from "ulid";
import { KeelsonError, unwrap } from "./errors.ts";
import type {
  CartCheck,
  ConnectionLimits,
  ConnectionRequestState,
  EvidenceManifest,
  OperatorMandate,
  Purchase,
} from "./generated/types.gen.ts";
import type { Keelson } from "./keelson.ts";

/**
 * Where a write stands. `pending_approval`: the user has to answer first. `approved`: the user or
 * Keelson said yes and the work continues on its own. `denied`: the user said no. `blocked`:
 * Keelson refused it under the mandate. `success`: done, for good. `error`: it failed;
 * `retryable` says whether calling again is safe.
 */
export type Status = "pending_approval" | "approved" | "denied" | "blocked" | "success" | "error";

/** Exactly what the agent does next. `tool` names the {@link KeelsonAgent} method, as Keelson's MCP tools name it. */
export interface Next {
  action: "show_user_then_poll" | "poll" | "call" | "tell_user" | "stop";
  tool?: string;
  arguments?: Record<string, unknown>;
  afterSeconds?: number;
  /** What to tell the user, or to do, in one sentence. */
  say: string;
}

/** The answer of every {@link KeelsonAgent} call: the same envelope Keelson's MCP tools answer with. */
export type Envelope<T extends object = object> = {
  status: Status;
  next: Next;
  message: string;
  retryable?: boolean;
} & T;

/** A request to the user, as an envelope carries it. */
export interface RequestFields {
  requestId: string;
  kind: ConnectionRequestState["kind"];
  state: ConnectionRequestState["state"];
  approvalUrl: string;
  userCode: string;
  /** Show it with the link: the user picks this number before the request opens. */
  matchNumber: number | null;
  expiresAt: string;
  mandateId: string | null;
}

/** A purchase, as an envelope carries it. */
export interface PurchaseFields {
  purchaseId: string;
  mandateId: string;
  state: string;
  amount: { currency: string; minor: number };
  logIndex: string | null;
  failure: { step: string; reason: string } | null;
  reasons: { field: string; mandate: string | null; cart: string | null }[];
  /** `unknown`: the money may have moved; never start the purchase again. */
  outcome: "known" | "pending" | "unknown";
}

/** States of a purchase PayPal captured: done, whatever happened after. */
const CAPTURED_OR_AFTER = new Set([
  "CAPTURED",
  "DELIVERED",
  "SETTLED",
  "DISPUTED",
  "ATTRIBUTED",
  "SLASHED",
  "WARRANTY_PAID",
  "DEFENDED",
  "MERCHANT_LIABLE",
]);

const envelope = <T extends object>(
  status: Status,
  next: Next,
  message: string,
  fields: T,
): Envelope<T> => ({ status, next, message, ...fields });

/** A failure as the envelope says it: retryable only when nothing was done and calling again is safe. */
function failed(err: unknown, tool: string): Envelope {
  const message = err instanceof Error ? err.message : String(err);
  const retryable =
    err instanceof KeelsonError && (err.status === 429 || err.status === 503 || err.status === 504);
  return envelope(
    "error",
    retryable
      ? {
          action: "poll",
          tool,
          afterSeconds: 30,
          say: "Keelson is busy or a dependency is down; nothing was done. Call the same tool once more in 30 seconds.",
        }
      : { action: "tell_user", say: `Tell the user it failed: ${message}` },
    message,
    { retryable },
  );
}

/** A request to the user in the envelope. */
function requestAnswer(r: ConnectionRequestState): Envelope<RequestFields> {
  const fields: RequestFields = {
    requestId: r.id,
    kind: r.kind,
    state: r.state,
    approvalUrl: r.approvalUrl,
    userCode: r.userCode,
    matchNumber: r.matchNumber,
    expiresAt: r.expiresAt,
    mandateId: r.mandateId,
  };
  const poll = {
    tool: "keelson.get_request",
    arguments: { requestId: r.id },
    afterSeconds: r.interval,
  };
  switch (r.state) {
    case "PENDING":
      return envelope(
        "pending_approval",
        {
          ...poll,
          action: "show_user_then_poll",
          say: `Show the user this link${r.matchNumber === null ? "" : ` and the number ${r.matchNumber}, which they pick on the page`}: ${r.approvalUrl}. Then poll keelson.get_request every ${r.interval} seconds.`,
        },
        "Waiting for the user to approve with a passkey.",
        fields,
      );
    case "APPROVED":
      return envelope(
        "approved",
        r.kind === "once"
          ? {
              action: "call",
              tool: "keelson.request_countersign",
              arguments: { mandateId: r.mandateId },
              say: `The user approved this one cart under mandate ${r.mandateId}: countersign the same cart and evidence under it. It allows that cart only.`,
            }
          : {
              action: "call",
              tool: "keelson.confirm_mandate",
              arguments: { mandateId: r.mandateId },
              say: "The user approved. Wait for the PayPal hold with keelson.confirm_mandate before buying.",
            },
        `Approved: mandate ${r.mandateId}.`,
        fields,
      );
    case "DENIED":
      return envelope(
        "denied",
        { action: "stop", say: "The user said no. Do not ask again unless they tell you to." },
        "The user declined.",
        fields,
      );
    default:
      return envelope(
        "error",
        {
          action: "tell_user",
          say: "The request expired before the user answered. Ask them whether to ask again.",
        },
        "The request expired.",
        { ...fields, retryable: false },
      );
  }
}

/** A purchase in the envelope. */
function purchaseAnswer(p: Purchase): Envelope<PurchaseFields> {
  const fields = {
    purchaseId: p.id,
    mandateId: p.mandateId,
    state: p.state,
    amount: { currency: p.amount.currency, minor: Number(p.amount.minor) },
    logIndex: p.logIndex ?? null,
    failure: p.failure ?? null,
    reasons: p.reasons ?? [],
  };
  const poll = {
    action: "poll" as const,
    tool: "keelson.get_purchase",
    arguments: { purchaseId: p.id },
    afterSeconds: 5,
  };
  if (CAPTURED_OR_AFTER.has(p.state)) {
    return envelope(
      "success",
      {
        action: "tell_user",
        say: `Bought. PayPal captured it; its Alibi is at keelson.get_alibi ${p.id}.`,
      },
      p.state === "CAPTURED"
        ? `Purchase ${p.id} is captured.`
        : `Purchase ${p.id} was captured; it is now ${p.state}.`,
      { ...fields, outcome: "known" as const },
    );
  }
  if (p.state === "DENIED") {
    const why = fields.reasons
      .map(
        (r) =>
          `${r.field}: the mandate allows ${r.mandate ?? "nothing"}, the cart has ${r.cart ?? "nothing"}`,
      )
      .join("; ");
    return envelope(
      "blocked",
      {
        action: "tell_user",
        say: `Keelson blocked this cart${why ? ` (${why})` : ""}. Do not retry the same cart; change it, or ask for more room with keelson.request_mandate_change.`,
      },
      "Keelson blocked the cart under the mandate.",
      { ...fields, outcome: "known" as const },
    );
  }
  if (p.state === "FAILED") {
    // A capture that failed after it was sent may still have moved the money.
    const unknown = p.failure?.step === "capture";
    return envelope(
      "error",
      unknown
        ? {
            ...poll,
            afterSeconds: 120,
            say: "We don't know yet whether PayPal charged this purchase. Don't start it again; check again in a few minutes.",
          }
        : {
            action: "tell_user",
            say: `It failed at ${p.failure?.step ?? "a step"} (${p.failure?.reason ?? "unknown"}); nothing was captured.`,
          },
      unknown ? "The outcome is not known yet." : "The purchase failed; nothing was captured.",
      { ...fields, outcome: unknown ? ("unknown" as const) : ("known" as const), retryable: false },
    );
  }
  return envelope(
    "approved",
    { ...poll, say: `Countersigned; it is ${p.state}. Poll keelson.get_purchase until success.` },
    `Purchase ${p.id} is ${p.state}.`,
    { ...fields, outcome: "pending" as const },
  );
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** The agent's P-256 `cnf` key from its private JWK, the key its mandates name. */
export async function importAgentKey(privateJwk: string | JsonWebKey): Promise<CryptoKey> {
  const jwk = (typeof privateJwk === "string" ? JSON.parse(privateJwk) : privateJwk) as JsonWebKey;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d) {
    throw new Error("the agent key is not a private P-256 JWK");
  }
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
}

export interface KeelsonAgentOptions {
  /**
   * The agent's `cnf` key, where it lives: its countersigns are closed with it. Leave it out for an
   * app acting for a user, whose mandates Keelson closes with its hosted operator's key.
   */
  agentKey?: CryptoKey;
  /** The operator's ERC-8004 agent id, which its mandates name. */
  agentId?: bigint | string;
}

/** What the agent read at the store, sealed as the evidence of one cart. */
export interface EvidenceInput {
  mandateId: string;
  /** The store's product answer, or answers, the cart was priced from. */
  product: unknown;
  /** The cart as the store priced it. */
  cart: Cart;
  /** What the agent read that led to this cart, verbatim. Never personal data. */
  observation: string;
}

/**
 * Keelson for an agent: the same steps and answers as Keelson's MCP tools, as SDK calls. Every
 * write answers an {@link Envelope}; a write is never called again to finish what it started:
 * {@link getRequest} and {@link getPurchase} are the polls.
 */
export class KeelsonAgent {
  readonly #agentKey: CryptoKey | undefined;
  readonly #agentId: string | undefined;

  constructor(
    readonly keelson: Keelson,
    options: KeelsonAgentOptions = {},
  ) {
    this.#agentKey = options.agentKey;
    this.#agentId = options.agentId?.toString();
  }

  /** Reads a request to the user. Safe to call every `next.afterSeconds`. */
  async getRequest(requestId: string): Promise<Envelope<RequestFields> | Envelope> {
    try {
      return requestAnswer(
        await unwrap(this.keelson.getConnectionRequest({ path: { id: requestId } })),
      );
    } catch (err) {
      return failed(err, "keelson.get_request");
    }
  }

  /** A request just made: its state, or a poll when it cannot be read yet. */
  async #asked(requestId: string): Promise<Envelope<RequestFields> | Envelope> {
    try {
      return requestAnswer(
        await unwrap(this.keelson.getConnectionRequest({ path: { id: requestId } })),
      );
    } catch {
      return envelope(
        "pending_approval",
        {
          action: "poll",
          tool: "keelson.get_request",
          arguments: { requestId },
          afterSeconds: 5,
          say: "The request was made. Poll keelson.get_request for its link and the user's answer.",
        },
        "The request was made; its state could not be read yet.",
        { requestId },
      );
    }
  }

  /**
   * Asks the user for a mandate (RFC 8628 device authorization): show `approvalUrl` with
   * `matchNumber`, then poll {@link getRequest}. Amounts are minor units.
   */
  async requestMandate(o: {
    /** How the user knows this agent. */
    name: string;
    /** Why you ask, 100 to 1000 characters; the user reads it. */
    reason: string;
    perPurchaseMinor: number;
    totalMinor: number;
    /** When the mandate ends, as an RFC 3339 date-time. */
    until: string;
    askAboveMinor?: number;
    currency?: ConnectionLimits["currency"];
  }): Promise<Envelope<RequestFields> | Envelope> {
    let requestId: string;
    try {
      const made = await unwrap(
        this.keelson.requestMandate({
          body: {
            name: o.name,
            reason: o.reason,
            limits: {
              currency: o.currency ?? "USD",
              perPurchaseMinor: o.perPurchaseMinor,
              totalMinor: o.totalMinor,
              until: o.until,
              ...(o.askAboveMinor === undefined ? {} : { askAboveMinor: o.askAboveMinor }),
            },
          },
        }),
      );
      requestId = made.request_id;
    } catch (err) {
      return failed(err, "keelson.request_mandate");
    }
    // The request exists now: whatever happens next, the agent polls it, never asks again.
    return this.#asked(requestId);
  }

  /** Asks the user for more room on a mandate, with a one-line note they read verbatim. */
  async requestMandateChange(o: {
    mandateId: string;
    note: string;
    perPurchaseMinor?: number;
    totalMinor?: number;
    until?: string;
  }): Promise<Envelope<RequestFields> | Envelope> {
    let requestId: string;
    try {
      const { mandateId, ...body } = o;
      const made = await unwrap(
        this.keelson.requestMandateChange({ path: { id: mandateId }, body }),
      );
      requestId = made.request_id;
    } catch (err) {
      return failed(err, "keelson.request_mandate_change");
    }
    return this.#asked(requestId);
  }

  #operator(agentId: bigint | string | undefined): string {
    const id = agentId?.toString() ?? this.#agentId;
    if (id === undefined) throw new Error("Name the operator's agentId.");
    return id;
  }

  /** The active mandates naming the operator, newest first. */
  async listMandates(agentId?: bigint | string): Promise<OperatorMandate[]> {
    const { mandates } = await unwrap(
      this.keelson.listOperatorMandates({ path: { agentId: this.#operator(agentId) } }),
    );
    return mandates;
  }

  /** Finds the signed mandate with its PayPal hold. Safe to poll. */
  async confirmMandate(
    o: { mandateId?: string; agentId?: bigint | string } = {},
  ): Promise<Envelope<{ mandate: OperatorMandate | null }> | Envelope> {
    try {
      const mandates = await this.listMandates(o.agentId);
      const found = mandates.find((m) =>
        o.mandateId ? m.id === o.mandateId : m.authorizationId !== null,
      );
      if (found && found.authorizationId !== null) {
        return envelope(
          "success",
          {
            action: "call",
            tool: "keelson.submit_evidence",
            arguments: { mandateId: found.id },
            say: `Mandate ${found.id} is held: ${found.remainingMinor} ${found.currency} minor units left until ${found.expiresAt}. Buy within it.`,
          },
          `Mandate ${found.id} is signed and held.`,
          { mandate: found },
        );
      }
      return envelope(
        "pending_approval",
        {
          action: "poll",
          tool: "keelson.confirm_mandate",
          arguments: o.mandateId ? { mandateId: o.mandateId } : {},
          afterSeconds: 10,
          say: "The user has not signed the mandate or approved its PayPal hold yet; poll keelson.confirm_mandate.",
        },
        "No signed and held mandate yet.",
        { mandate: found ?? null },
      );
    } catch (err) {
      return failed(err, "keelson.confirm_mandate");
    }
  }

  /**
   * Seals what the agent saw at decision time (the store's product and cart answers and the
   * agent's own observation, each salted) and stores the manifest with Keelson. Returns the
   * evidence root to countersign under.
   */
  async submitEvidence(
    o: EvidenceInput,
  ): Promise<Envelope<{ evidenceRoot: string; cart: Cart; items: string[] }> | Envelope> {
    try {
      const salt = () => crypto.getRandomValues(new Uint8Array(32));
      const items: SealedItem[] = [
        {
          type: "api.product",
          mediaType: MEDIA_TYPES["api.product"],
          bytes: canonicalBytes(o.product),
          salt: salt(),
        },
        {
          type: "api.cart",
          mediaType: MEDIA_TYPES["api.cart"],
          bytes: canonicalBytes(o.cart),
          salt: salt(),
        },
        {
          type: "llm.observation",
          mediaType: MEDIA_TYPES["llm.observation"],
          bytes: new TextEncoder().encode(o.observation),
          salt: salt(),
        },
      ];
      const { evidenceRoot } = await unwrap(
        this.keelson.storeEvidence({
          body: {
            mandateId: o.mandateId,
            manifest: buildManifest(items) as EvidenceManifest,
            items: items.map((i) => ({
              type: i.type,
              mediaType: i.mediaType,
              salt: b64(i.salt),
              bytes: b64(i.bytes),
            })),
          },
        }),
      );
      return envelope(
        "success",
        {
          action: "call",
          tool: "keelson.check_cart",
          arguments: { mandateId: o.mandateId, evidenceRoot, cart: o.cart },
          say: "Check it with keelson.check_cart, then countersign it with keelson.request_countersign.",
        },
        `Evidence sealed under ${evidenceRoot}.`,
        { evidenceRoot, cart: o.cart, items: items.map((i) => i.type) },
      );
    } catch (err) {
      return failed(err, "keelson.submit_evidence");
    }
  }

  /** A dry run of the countersign: what would pass, field by field. Nothing is signed or reserved. */
  async checkCart(o: { mandateId: string; cart: Cart }): Promise<Envelope<CartCheck> | Envelope> {
    try {
      const check = await unwrap(
        this.keelson.checkCart({ path: { id: o.mandateId }, body: { cart: o.cart } }),
      );
      if (!check.canAttempt) {
        return envelope(
          "blocked",
          {
            action: "tell_user",
            say: check.blockers.map((b) => `${b.message} ${b.next}`).join(" "),
          },
          "This cart would not pass the mandate.",
          check,
        );
      }
      return envelope(
        "success",
        {
          action: "call",
          tool: "keelson.request_countersign",
          say: check.needsApproval
            ? "It passes, and is above the user's ask-me amount: the countersign pauses it for their one-time approval."
            : "It passes. Countersign it once.",
        },
        "This cart would pass the mandate.",
        check,
      );
    } catch (err) {
      return failed(err, "keelson.check_cart");
    }
  }

  /**
   * Asks Keelson to countersign the cart under the mandate with its evidence. On allow the
   * purchase is logged, covered by the operator's bond and captured on PayPal. Send it once: on
   * anything but a refusal, poll {@link getPurchase} with the `purchaseId` it returns.
   */
  async requestCountersign(o: {
    mandateId: string;
    evidenceRoot: string;
    cart: Cart;
    agentId?: bigint | string;
    /** Only when the user asked to buy this same cart again: the purchase it repeats. */
    repeatOf?: string;
  }): Promise<Envelope<PurchaseFields> | Envelope<RequestFields> | Envelope> {
    let sent: string | undefined;
    try {
      const mandate = (await this.listMandates(o.agentId)).find((m) => m.id === o.mandateId);
      if (!mandate) throw new Error(`Mandate ${o.mandateId} is not active for this operator.`);
      if (mandate.holdMode !== "mandate" || mandate.authorizationId === null) {
        throw new Error(
          "This mandate holds each purchase separately; buy under a mandate held as a whole.",
        );
      }
      const requestId = ulid();
      const authority = this.#agentKey
        ? {
            closedMandate: await closeMandate(
              mandate.openMandate,
              { requestId, cartHash: `sha256:${toHex(cartHash(o.cart)).slice(2)}` },
              this.#agentKey,
            ),
          }
        : { mandateId: o.mandateId, requestId };
      const total = o.cart.lines.reduce((sum, l) => sum + BigInt(l.qty) * BigInt(l.unit_minor), 0n);
      const value = toPayPalValue({ currency: o.cart.currency as CurrencyCode, minor: total });
      let purchaseId = requestId;
      sent = requestId;
      let approval: { request_id?: string; verification_uri_complete?: string } | undefined;
      try {
        const signed = await unwrap(
          this.keelson.countersign({
            body: {
              authorizationId: mandate.authorizationId,
              ...authority,
              cart: o.cart,
              unit: {
                amount: {
                  currency_code: o.cart.currency,
                  value,
                  breakdown: { item_total: { currency_code: o.cart.currency, value } },
                },
              },
              evidenceRoot: o.evidenceRoot,
              ...(o.repeatOf ? { repeatOf: o.repeatOf } : {}),
            },
          }),
        );
        purchaseId = signed.purchaseId ?? requestId;
        approval = signed.approval;
      } catch (err) {
        if (!(err instanceof KeelsonError)) throw err;
        // A retry after a lost answer: the purchase already made of this cart is the answer.
        if (err.type === "purchase-exists" && typeof err.problem.purchaseId === "string") {
          purchaseId = err.problem.purchaseId;
          sent = purchaseId;
        }
        // Above the user's ask-me amount: paused before any TEE saw it.
        else if (err.type === "approval-required") {
          approval = err.problem.approval as typeof approval;
          purchaseId = "";
        } else throw err;
      }
      if (approval?.request_id) return this.#asked(approval.request_id);
      return purchaseAnswer(await unwrap(this.keelson.getPurchase({ path: { id: purchaseId } })));
    } catch (err) {
      // A refusal answered before anything ran may be retried; anything after the send is polled.
      const refused =
        err instanceof KeelsonError && err.status >= 400 && err.status < 500 && err.status !== 429;
      if (sent && !refused) {
        return envelope(
          "error",
          {
            action: "poll",
            tool: "keelson.get_purchase",
            arguments: { purchaseId: sent },
            afterSeconds: 30,
            say: "The countersign was sent and its outcome is not known yet. Don't send it again; poll keelson.get_purchase.",
          },
          err instanceof Error ? err.message : String(err),
          { purchaseId: sent, outcome: "unknown", retryable: false },
        );
      }
      return failed(err, "keelson.request_countersign");
    }
  }

  /** Reads a purchase. Safe to call every `next.afterSeconds`. */
  async getPurchase(purchaseId: string): Promise<Envelope<PurchaseFields> | Envelope> {
    try {
      return purchaseAnswer(await unwrap(this.keelson.getPurchase({ path: { id: purchaseId } })));
    } catch (err) {
      return failed(err, "keelson.get_purchase");
    }
  }

  /**
   * Follows a request or purchase envelope until it leaves `pending_approval`/`approved` with a
   * poll, waiting `next.afterSeconds` between reads.
   */
  async settle<T extends Envelope>(
    first: T,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<Envelope> {
    const until = Date.now() + (options.timeoutMs ?? 15 * 60_000);
    let current: Envelope = first;
    while (
      (current.next.action === "poll" || current.next.action === "show_user_then_poll") &&
      Date.now() < until
    ) {
      await new Promise((r) => setTimeout(r, (current.next.afterSeconds ?? 5) * 1000));
      options.signal?.throwIfAborted();
      const args = current.next.arguments ?? {};
      if (current.next.tool === "keelson.get_request") {
        current = await this.getRequest(args.requestId as string);
      } else if (current.next.tool === "keelson.get_purchase") {
        current = await this.getPurchase(args.purchaseId as string);
      } else if (current.next.tool === "keelson.confirm_mandate") {
        current = await this.confirmMandate(args as { mandateId?: string });
      } else break;
    }
    return current;
  }
}

export type { Cart };
