import type { Keelson } from "./client.ts";
import { APIError, KeelsonError, OutcomeUnknownError } from "./errors.ts";
import { EXPORT_FORMATS, type ExportFormat } from "./resources/alibis.ts";
import type { Mandate } from "./resources/mandates.ts";
import { quote } from "./sandbox.ts";
import type { Cart } from "./types.ts";

/** What the agent does next, in the same shape as Keelson's MCP server. */
export interface Next {
  action: "show_user_then_poll" | "poll" | "call" | "tell_user" | "stop";
  tool?: string;
  arguments?: Record<string, unknown>;
  afterSeconds?: number;
  /** What to tell the user, or to do, in one sentence. */
  say: string;
}

/** Every tool answers with an envelope; it never throws at the model. */
export interface Envelope {
  status: "pending_approval" | "approved" | "denied" | "blocked" | "success" | "error";
  next: Next;
  message: string;
  /** On `error`: whether calling the same tool again is safe. */
  retryable?: boolean;
  [field: string]: unknown;
}

/** A JSON Schema (draft 2020-12) object. */
export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: false;
}

/** A framework-neutral tool; the adapters wrap these. */
export interface KeelsonTool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Changes nothing; safe to call as often as needed. */
  readOnly: boolean;
  execute(input: Record<string, unknown>): Promise<Envelope>;
}

const NEVER_AGAIN =
  "Never call this tool again to finish or check what it started: that starts a new operation. Follow `next`, and poll keelson_get_request or keelson_get_purchase.";
const ULID = { type: "string", pattern: "^[0-7][0-9A-HJKMNP-TV-Z]{25}$" };
const CART = {
  type: "object",
  description: "The cart keelson_submit_evidence returned, unchanged.",
  additionalProperties: true,
};
const PENDING = new Set(["PROPOSED", "EVALUATING", "COUNTERSIGNED", "LOGGED", "COVERED"]);

function failed(err: unknown, tool: string): Envelope {
  const message = err instanceof Error ? err.message : String(err);
  const retryable =
    err instanceof APIError && (err.status === 429 || err.status === 503 || err.status === 504);
  return {
    status: "error",
    next: retryable
      ? {
          action: "poll",
          tool,
          afterSeconds: 30,
          say: "Keelson is busy or a dependency is down; nothing was done. Call the same tool once more in 30 seconds.",
        }
      : { action: "tell_user", say: `Tell the user it failed: ${message}` },
    message,
    retryable,
  };
}

const money = (minor: number, currency = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    minor /
      10 **
        (new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
          .maximumFractionDigits ?? 2),
  );

/**
 * Keelson's tools for an agent framework, with the names and answers of Keelson's MCP server
 * (`keelson.request_mandate` is `keelson_request_mandate` here, since some frameworks allow no
 * dots in a tool name).
 */
export function tools(keelson: Keelson, o: { agentId?: string } = {}): KeelsonTool[] {
  const held = new Map<string, Mandate>();
  let agentId = o.agentId ?? process.env.KEELSON_AGENT_ID;

  const requestAnswer = async (requestId: string): Promise<Envelope> => {
    const r = await keelson.requests.retrieve(requestId);
    agentId = r.operatorAgentId;
    const fields = {
      requestId: r.id,
      kind: r.kind,
      state: r.state,
      mandateId: r.mandateId,
      approvalUrl: r.approvalUrl,
      userCode: r.userCode,
      matchNumber: r.matchNumber,
      expiresAt: r.expiresAt,
    };
    if (r.state === "PENDING") {
      return {
        status: "pending_approval",
        next: {
          action: "show_user_then_poll",
          tool: "keelson_get_request",
          arguments: { requestId: r.id },
          afterSeconds: r.interval,
          say: `Ask the user to approve at ${r.approvalUrl}${r.matchNumber ? ` and pick ${r.matchNumber}` : ""}, then poll keelson_get_request.`,
        },
        message: "Waiting for the user's passkey.",
        ...fields,
      };
    }
    if (r.state === "APPROVED") {
      return {
        status: "approved",
        next: {
          action: "call",
          tool: "keelson_confirm_mandate",
          arguments: { mandateId: r.mandateId },
          say: "The user signed. Confirm the mandate's PayPal hold with keelson_confirm_mandate.",
        },
        message: `The user approved mandate ${r.mandateId}.`,
        ...fields,
      };
    }
    return {
      status: "denied",
      next: {
        action: "stop",
        say: "The user declined or let it expire. Do not ask again unless they ask you to.",
      },
      message: `The request is ${r.state.toLowerCase()}.`,
      ...fields,
    };
  };

  const mandateOf = async (mandateId: string): Promise<Mandate> => {
    const cached = held.get(mandateId);
    if (cached) return cached;
    if (!agentId) throw new KeelsonError("Read the request with keelson_get_request first.");
    const found = (await keelson.mandates.list(agentId)).find((m) => m.id === mandateId);
    if (!found) throw new KeelsonError(`Mandate ${mandateId} is not active.`);
    held.set(found.id, found);
    return found;
  };

  const purchaseAnswer = async (purchaseId: string): Promise<Envelope> => {
    const p = await keelson.purchases.retrieve(purchaseId);
    const fields = { purchaseId: p.id, state: p.state, amount: p.amount, logIndex: p.logIndex };
    if (PENDING.has(p.state)) {
      return {
        status: "approved",
        next: {
          action: "poll",
          tool: "keelson_get_purchase",
          arguments: { purchaseId: p.id },
          afterSeconds: 5,
          say: "Keelson allowed it; the capture is under way. Poll keelson_get_purchase.",
        },
        message: `Purchase ${p.id} is ${p.state}.`,
        ...fields,
      };
    }
    if (p.state === "CAPTURED") {
      return {
        status: "success",
        next: {
          action: "stop",
          say: `Bought. The Alibi is at https://verify.keelson.finance/?id=${p.id}.`,
        },
        message: `Purchase ${p.id} is captured on PayPal.`,
        ...fields,
      };
    }
    return {
      status: p.state === "DENIED" ? "blocked" : "error",
      next: { action: "tell_user", say: `Tell the user Keelson stopped it: ${p.state}.` },
      message: `Purchase ${p.id} is ${p.state}.`,
      retryable: false,
      ...fields,
    };
  };

  const tool = (
    name: string,
    description: string,
    properties: JsonSchema["properties"],
    required: string[],
    readOnly: boolean,
    run: (input: Record<string, unknown>) => Promise<Envelope>,
  ): KeelsonTool => ({
    name,
    description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    readOnly,
    async execute(input) {
      try {
        return await run(input);
      } catch (err) {
        if (err instanceof OutcomeUnknownError) {
          return {
            status: "error",
            next: {
              action: "poll",
              tool: "keelson_get_purchase",
              arguments: { purchaseId: err.requestId },
              afterSeconds: 30,
              say: "The countersign was sent and its outcome is not known yet. Don't send it again; poll keelson_get_purchase.",
            },
            message: err.message,
            purchaseId: err.requestId,
            outcome: "unknown",
            retryable: false,
          };
        }
        return failed(err, name);
      }
    },
  });

  return [
    tool(
      "keelson_request_mandate",
      `Asks the user to let this agent spend within limits. The user approves on Keelson's page with a passkey and may lower any limit. Never buy before keelson_get_request says approved, and never ask again after a decline. ${NEVER_AGAIN}`,
      {
        name: {
          type: "string",
          minLength: 1,
          maxLength: 64,
          description: "How the user knows this agent, e.g. 'Claude Code'.",
        },
        reason: {
          type: "string",
          minLength: 100,
          maxLength: 1000,
          description:
            "Why you ask, in at least 100 characters; the user reads it before approving.",
        },
        perPurchaseMinor: {
          type: "integer",
          minimum: 1,
          description: "Most one purchase may cost, in cents.",
        },
        totalMinor: {
          type: "integer",
          minimum: 1,
          description: "Most all purchases may cost together, in cents.",
        },
        until: {
          type: "string",
          format: "date-time",
          description: "When the mandate ends; keep it short.",
        },
        askAboveMinor: {
          type: "integer",
          minimum: 1,
          description: "Above this the user approves each purchase, in cents.",
        },
      },
      ["name", "reason", "perPurchaseMinor", "totalMinor", "until"],
      false,
      async (i) => {
        const req = await keelson.mandates.request({
          name: i.name as string,
          reason: i.reason as string,
          perPurchase: { currency: "USD", minor: i.perPurchaseMinor as number },
          total: { currency: "USD", minor: i.totalMinor as number },
          until: i.until as string,
          ...(i.askAboveMinor
            ? { askAbove: { currency: "USD", minor: i.askAboveMinor as number } }
            : {}),
        });
        const answer = await requestAnswer(req.id);
        return {
          ...answer,
          message: `${i.name} asks to spend up to ${money(i.totalMinor as number)}. ${answer.message}`,
        };
      },
    ),
    tool(
      "keelson_get_request",
      "Reads where a request to the user stands: a mandate, a change of one, or one cart paused for approval. Safe to call as often as `next.afterSeconds` allows; it never changes anything.",
      { requestId: { ...ULID, description: "The `requestId` a write tool returned." } },
      ["requestId"],
      true,
      async (i) => requestAnswer(i.requestId as string),
    ),
    tool(
      "keelson_request_mandate_change",
      `Asks the user to change the mandate, with a one-line note they read verbatim (e.g. 'Needs $40 more for shipping'). The user may lower the limits and signs with a passkey; nothing changes until they sign. ${NEVER_AGAIN}`,
      {
        mandateId: ULID,
        note: {
          type: "string",
          minLength: 10,
          maxLength: 280,
          description: "Why, in one line the user reads.",
        },
        perPurchaseMinor: { type: "integer", minimum: 1 },
        totalMinor: { type: "integer", minimum: 1 },
        until: { type: "string", format: "date-time" },
      },
      ["mandateId", "note"],
      false,
      async (i) => {
        const req = await keelson.mandates.requestChange(i.mandateId as string, {
          note: i.note as string,
          ...(i.perPurchaseMinor
            ? { perPurchase: { currency: "USD", minor: i.perPurchaseMinor as number } }
            : {}),
          ...(i.totalMinor ? { total: { currency: "USD", minor: i.totalMinor as number } } : {}),
          ...(i.until ? { until: i.until as string } : {}),
        });
        return requestAnswer(req.id);
      },
    ),
    tool(
      "keelson_confirm_mandate",
      "Finds the signed mandate the agent may buy under, with its PayPal hold and what is left of it. If the user has not approved the hold yet, asks them to finish in the Keelson app. Safe to poll.",
      { mandateId: ULID },
      ["mandateId"],
      true,
      async (i) => {
        const id = i.mandateId as string;
        held.delete(id);
        const m = await mandateOf(id).catch(() => undefined);
        if (m?.authorizationId) {
          return {
            status: "success",
            next: {
              action: "call",
              tool: "keelson_submit_evidence",
              arguments: { mandateId: m.id },
              say: `Mandate ${m.id} is held: ${money(m.remainingMinor, m.currency)} left until ${m.expiresAt}. Buy within it.`,
            },
            message: `Mandate ${m.id} is signed and held.`,
            mandate: {
              id: m.id,
              remainingMinor: m.remainingMinor,
              currency: m.currency,
              expiresAt: m.expiresAt,
            },
          };
        }
        return {
          status: "pending_approval",
          next: {
            action: "show_user_then_poll",
            tool: "keelson_confirm_mandate",
            arguments: { mandateId: id },
            afterSeconds: 10,
            say: `Ask the user to approve the PayPal hold at https://app.keelson.finance/mandate?id=${id}, then poll keelson_confirm_mandate.`,
          },
          message: "No held mandate yet.",
        };
      },
    ),
    tool(
      "keelson_submit_evidence",
      `Prices the cart from the store itself and seals what the agent saw at decision time: the store's product and cart answers and the agent's own observation. Returns the evidence root and the cart to countersign. ${NEVER_AGAIN}`,
      {
        mandateId: ULID,
        lines: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "object",
            properties: {
              productUrl: {
                type: "string",
                format: "uri",
                description: "The product page on the store.",
              },
              size: { type: "string", minLength: 1, maxLength: 32 },
              qty: { type: "integer", minimum: 1, maximum: 5 },
            },
            required: ["productUrl", "size", "qty"],
            additionalProperties: false,
          },
        },
        observation: {
          type: "string",
          minLength: 1,
          maxLength: 100_000,
          description:
            "What the agent read on the store that led to this cart, verbatim. No personal data.",
        },
      },
      ["mandateId", "lines", "observation"],
      false,
      async (i) => {
        const q = await quote(i.lines as { productUrl: string; size: string; qty: number }[]);
        const { evidenceRoot, items } = await keelson.evidence.seal({
          mandateId: i.mandateId as string,
          sources: { ...q.sources, observation: i.observation as string },
        });
        return {
          status: "success",
          next: {
            action: "call",
            tool: "keelson_request_countersign",
            arguments: { mandateId: i.mandateId, evidenceRoot, cart: q.cart },
            say: "Check it with keelson_check_cart, then countersign it with keelson_request_countersign.",
          },
          message: `Evidence sealed under ${evidenceRoot} for a cart of ${money(q.total.minor, q.total.currency)}.`,
          evidenceRoot,
          cart: q.cart,
          total: q.total,
          items,
        };
      },
    ),
    tool(
      "keelson_check_cart",
      "Checks a cart against the mandate as it stands, without buying: whether a countersign would pass, and what to do about each blocker. Safe to call as often as needed.",
      { mandateId: ULID, cart: CART },
      ["mandateId", "cart"],
      true,
      async (i) => {
        const c = await keelson.mandates.check(i.mandateId as string, i.cart as Cart);
        return {
          status: c.canAttempt ? "success" : "blocked",
          next: c.canAttempt
            ? {
                action: "call",
                tool: "keelson_request_countersign",
                say: c.needsApproval
                  ? "It passes and needs the user's one-time approval; countersign to ask."
                  : "It passes; countersign it.",
              }
            : { action: "tell_user", say: c.blockers.map((b) => b.next).join(" ") },
          message: c.canAttempt
            ? "The cart passes the mandate."
            : c.blockers.map((b) => b.message).join(" "),
          ...c,
        };
      },
    ),
    tool(
      "keelson_request_countersign",
      `Asks Keelson to countersign the cart under the mandate, with the evidence submitted for it. Keelson's two TEEs check every field; on allow, the purchase is logged, covered by the operator's bond and captured on PayPal. A block is Keelson's answer, not an error. ${NEVER_AGAIN}`,
      {
        mandateId: ULID,
        evidenceRoot: {
          type: "string",
          pattern: "^0x[0-9a-f]{64}$",
          description: "The root keelson_submit_evidence returned.",
        },
        cart: CART,
        repeatOf: {
          ...ULID,
          description:
            "Only when the user explicitly asked to buy this same cart again: the purchase of it you got last. Never on a retry.",
        },
      },
      ["mandateId", "evidenceRoot", "cart"],
      false,
      async (i) => {
        const signed = await keelson.purchases.countersign({
          mandate: await mandateOf(i.mandateId as string),
          evidenceRoot: i.evidenceRoot as string,
          cart: i.cart as Cart,
          ...(i.repeatOf ? { repeatOf: i.repeatOf as string } : {}),
        });
        if (signed.approval) return requestAnswer(signed.approval.requestId);
        await keelson.purchases
          .waitFor(signed.purchaseId, { timeoutMs: 30_000 })
          .catch(() => undefined);
        return purchaseAnswer(signed.purchaseId);
      },
    ),
    tool(
      "keelson_get_purchase",
      "Reads a purchase: its state, amount, log index and capture. Safe to poll.",
      { purchaseId: ULID },
      ["purchaseId"],
      true,
      async (i) => purchaseAnswer(i.purchaseId as string),
    ),
    tool(
      "keelson_verify_alibi",
      "Runs the verifier's checks on a purchase's Alibi: TEE signatures and attestations, log inclusion and cosignatures, timestamps and the on-chain anchor. The browser verifier is the reference.",
      { purchaseId: ULID },
      ["purchaseId"],
      true,
      async (i) => {
        const id = i.purchaseId as string;
        const report = await keelson.alibis.verifyRemote(await keelson.alibis.retrieve(id));
        const verifyUrl = `https://verify.keelson.finance/?id=${id}`;
        return {
          status: report.verdict === "failed" ? "blocked" : "success",
          next: { action: "stop", say: `Anyone can check it in the browser at ${verifyUrl}.` },
          message: `The Alibi is ${report.verdict}.`,
          verdict: report.verdict,
          checks: report.checks.map((c) => ({
            id: c.id,
            status: c.status,
            ...(c.reason ? { reason: c.reason } : {}),
          })),
          verifyUrl,
        };
      },
    ),
    tool(
      "keelson_export_alibi",
      "The purchase in an agentic-commerce standard: AP2 mandates and receipts (ap2), a Mastercard Verifiable Intent chain (vi), a UCP checkout (ucp), an ACP allowance (acp), a signed Visa TAP request (tap) or the Visa evidence pack for a chargeback (visa). Each carries the purchase's SCITT transparent statement and is signed by Keelson's attested enclave.",
      { purchaseId: ULID, format: { type: "string", enum: [...EXPORT_FORMATS] } },
      ["purchaseId", "format"],
      true,
      async (i) => {
        const format = i.format as ExportFormat;
        try {
          const artifact = await keelson.alibis.export(i.purchaseId as string, format);
          const pending = "pending_close" in artifact;
          return {
            status: "success",
            next: {
              action: "tell_user",
              say: pending
                ? "Close the open mandates with your own agent key before presenting them."
                : `Hand the ${format} export to whoever asked for it.`,
            },
            message: `The purchase as ${format}, signed by Keelson's attested enclave.`,
            artifact,
          };
        } catch (err) {
          if (err instanceof APIError && (err.status === 409 || err.status === 503)) {
            return {
              status: "blocked",
              next: {
                action: "tell_user",
                say: `Tell the user this export is not available: ${err.message}`,
              },
              message: err.message,
              reason: String(err.problem.reason ?? "unavailable"),
            };
          }
          throw err;
        }
      },
    ),
    tool(
      "keelson_get_trust_grade",
      "An operator's trust grade (A to F), the premium each new coverage pays and the bond it should hold, from its coverages and verdicts.",
      {
        agentId: {
          type: "string",
          pattern: "^\\d{1,20}$",
          description: "The operator's ERC-8004 agent id.",
        },
      },
      ["agentId"],
      true,
      async (i) => {
        const g = await keelson.operators.grade(i.agentId as string);
        return {
          status: "success",
          next: { action: "stop", say: `Operator ${g.agentId} is graded ${g.grade}.` },
          message: `Operator ${g.agentId} is graded ${g.grade}.`,
          ...g,
        };
      },
    ),
  ];
}
