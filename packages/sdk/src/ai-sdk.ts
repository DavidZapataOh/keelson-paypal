import { type Tool, tool } from "ai";
import { z } from "zod";
import type { Cart as CartValue, KeelsonAgent } from "./agent.ts";
import { fetchAlibi, verifyAlibi } from "./verify.ts";

const Ulid = z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const Cart = z.object({
  merchant: z.string().min(1).max(256),
  currency: z.string().length(3),
  lines: z
    .array(
      z.object({
        sku: z.string().max(256),
        size: z.string().max(256).nullable().optional(),
        color: z.string().max(256).nullable().optional(),
        category: z.string().max(256),
        qty: z.int().min(1),
        unit_minor: z.int().min(0),
      }),
    )
    .min(1)
    .max(10),
  return_days: z.int().min(0),
  returns_free: z.boolean(),
});

/** The rule every write tool's description ends with. */
const NEVER_AGAIN =
  "Never call this tool again to finish or check what it started: follow `next`, and poll keelson_get_request or keelson_get_purchase.";

export interface KeelsonAgentToolkitOptions {
  agent: KeelsonAgent;
}

/**
 * Keelson's tools for the AI SDK, in the PayPal Agent Toolkit's shape: spread them next to
 * `new PayPalAgentToolkit(...).getTools()` so the agent asks for a mandate, seals evidence and
 * gets every cart countersigned before PayPal captures it. Each tool answers Keelson's envelope,
 * `{status, next, message}`, whose `next.tool` names the tool to call next.
 *
 * @example
 * const tools = {
 *   ...paypalToolkit.getTools(),
 *   ...new KeelsonAgentToolkit({ agent }).getTools(),
 * };
 */
export class KeelsonAgentToolkit {
  readonly #tools: Record<string, Tool>;

  constructor({ agent }: KeelsonAgentToolkitOptions) {
    this.#tools = {
      keelson_request_mandate: tool({
        description: `Asks the user to let this agent spend within limits. They approve on Keelson's page with a passkey after picking the two-digit number shown with the link, and may lower any limit. Amounts are minor units. ${NEVER_AGAIN}`,
        inputSchema: z.object({
          name: z.string().min(1).max(64).describe("How the user knows this agent."),
          reason: z.string().min(100).max(1000).describe("Why you ask; the user reads it."),
          perPurchaseMinor: z.int().positive(),
          totalMinor: z.int().positive(),
          until: z.iso.datetime({ offset: true }).describe("When the mandate ends."),
          askAboveMinor: z.int().positive().optional(),
        }),
        execute: (input) =>
          agent.requestMandate(
            input.askAboveMinor === undefined
              ? {
                  name: input.name,
                  reason: input.reason,
                  perPurchaseMinor: input.perPurchaseMinor,
                  totalMinor: input.totalMinor,
                  until: input.until,
                }
              : { ...input, askAboveMinor: input.askAboveMinor },
          ),
      }),
      keelson_get_request: tool({
        description: "Reads where a request to the user stands. Never changes anything.",
        inputSchema: z.object({ requestId: Ulid }),
        execute: ({ requestId }) => agent.getRequest(requestId),
      }),
      keelson_confirm_mandate: tool({
        description:
          "Finds the signed mandate with its PayPal hold and what is left of it. Safe to poll.",
        inputSchema: z.object({ mandateId: Ulid.optional() }),
        execute: ({ mandateId }) => agent.confirmMandate(mandateId ? { mandateId } : {}),
      }),
      keelson_submit_evidence: tool({
        description: `Seals what you read at the store for this cart: the store's product answer, the cart it priced and your own observation, verbatim and without personal data. ${NEVER_AGAIN}`,
        inputSchema: z.object({
          mandateId: Ulid,
          product: z.unknown().describe("The store's product answer the cart was priced from."),
          cart: Cart,
          observation: z.string().min(1).max(100_000),
        }),
        execute: (input) => agent.submitEvidence({ ...input, cart: input.cart as CartValue }),
      }),
      keelson_check_cart: tool({
        description:
          "A dry run of the countersign for this cart under the mandate, field by field. Nothing is signed or reserved.",
        inputSchema: z.object({ mandateId: Ulid, cart: Cart }),
        execute: (input) => agent.checkCart({ ...input, cart: input.cart as CartValue }),
      }),
      keelson_request_countersign: tool({
        description: `Countersigns the cart under the mandate with its evidence. On allow the purchase is logged, covered by the operator's bond and captured on PayPal. A block is Keelson's answer, not an error. ${NEVER_AGAIN}`,
        inputSchema: z.object({
          mandateId: Ulid,
          evidenceRoot: Hex32,
          cart: Cart,
          repeatOf: Ulid.optional().describe(
            "Only when the user asked to buy this same cart again. Never on a retry.",
          ),
        }),
        execute: ({ repeatOf, cart, ...input }) =>
          agent.requestCountersign({
            ...input,
            cart: cart as CartValue,
            ...(repeatOf ? { repeatOf } : {}),
          }),
      }),
      keelson_get_purchase: tool({
        description: "Reads where a purchase stands. Never changes anything.",
        inputSchema: z.object({ purchaseId: Ulid }),
        execute: ({ purchaseId }) => agent.getPurchase(purchaseId),
      }),
      keelson_verify_alibi: tool({
        description:
          "Verifies a purchase's Alibi on this machine: the user's passkey, both TEE attestations and countersignatures, the policy replay, log inclusion, witnesses and timestamps.",
        inputSchema: z.object({ purchaseId: Ulid }),
        execute: async ({ purchaseId }) => {
          const report = await verifyAlibi(await fetchAlibi(agent.keelson, purchaseId));
          return {
            verdict: report.verdict,
            checks: report.checks.map((c) => ({
              id: c.id,
              status: c.status,
              ...(c.reason ? { reason: c.reason } : {}),
            })),
          };
        },
      }),
    };
  }

  getTools(): Record<string, Tool> {
    return this.#tools;
  }
}
