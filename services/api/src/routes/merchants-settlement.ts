import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { addresses } from "@keelson/chain";
import { keelsonDomain } from "@keelson/core/eip712";
import { merchantSettlement, sql } from "@keelson/db";
import { type Address, type Hex, verifyTypedData } from "viem";
import type { Deps } from "../app.ts";
import { MERCHANTS, SETTLEMENT } from "../merchants.ts";
import { requireClient } from "../middleware/auth.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Receiver = z.union([z.email(), z.string().regex(/^[A-Z0-9]{13}$/)]).openapi({
  description: "The PayPal account paid: an email address or a PayPal account id.",
});

const Uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n, "at most 256 bits");

const SettlementPreference = z.object({
  rail: z.enum(["pyusd", "paypal"]).openapi({
    description:
      "`pyusd`: slashes and warranties pay the merchant in PYUSD on chain. `paypal`: they pay Keelson's treasury, and Keelson sends the merchant a PayPal Payout in USD.",
  }),
  paypal_receiver: Receiver.optional(),
});

const SignedSettlementPreference = SettlementPreference.extend({
  nonce: Uint.openapi({ description: "Higher than the nonce of the merchant's last choice." }),
  deadline: Uint.openapi({ description: "Unix seconds after which the signature is refused." }),
  merchant_signature: z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .openapi({
      description:
        "The merchant's EIP-712 `SettlementPreference(string merchantId,string rail,string paypalReceiver,uint256 nonce,uint256 deadline)` under the bond vault's domain, by its settlement address; `paypalReceiver` is empty for `pyusd`.",
    }),
})
  .refine((b) => b.rail === "pyusd" || b.paypal_receiver !== undefined, {
    message: "the paypal rail needs a paypal_receiver",
    path: ["paypal_receiver"],
  })
  .refine((b) => BigInt(b.deadline) >= BigInt(Math.floor(Date.now() / 1000)), {
    message: "the signature expired",
    path: ["deadline"],
  })
  .openapi("SignedSettlementPreference");

const CHAIN_ID = 421614;

/** The typed data a merchant signs to choose how it is paid. */
export function settlementPreferenceTypedData(message: {
  merchantId: string;
  rail: "pyusd" | "paypal";
  paypalReceiver: string;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: keelsonDomain(CHAIN_ID, addresses[CHAIN_ID].KeelsonBondVault as Address),
    types: {
      SettlementPreference: [
        { name: "merchantId", type: "string" },
        { name: "rail", type: "string" },
        { name: "paypalReceiver", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "SettlementPreference",
    message,
  } as const;
}

const route = createRoute({
  method: "put",
  path: "/v1/merchants/{merchantId}/settlement",
  tags: ["merchants"],
  summary: "Choose how a merchant is paid when a dispute goes its way",
  description:
    "Applies to verdicts signed afterwards: the rail decides the payee the TEE legs sign into the `Verdict`. The merchant signs the choice, as it signs its on-chain payout address.",
  middleware: [requireClient(["merchants:write"])],
  request: {
    params: z.object({ merchantId: z.string().min(1).max(64) }),
    body: {
      required: true,
      content: { "application/json": { schema: SignedSettlementPreference } },
    },
  },
  responses: {
    200: {
      description: "Stored",
      content: { "application/json": { schema: SettlementPreference } },
    },
    403: {
      description: "The signature is not the merchant's",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    404: {
      description: "No such merchant",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
    409: {
      description: "The nonce is not higher than the one of the merchant's last choice",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerMerchantsSettlement(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "merchantSigners">,
): void {
  const signers = deps.merchantSigners ?? SETTLEMENT;
  app.openapi(route, async (c) => {
    const { merchantId } = c.req.valid("param");
    const signer = signers[merchantId];
    if (!MERCHANTS.some((m) => m.id === merchantId) || !signer) {
      return problem(c, 404, "not-found", "Not found", "No such merchant.");
    }
    const body = c.req.valid("json");
    const paypalReceiver = body.rail === "paypal" ? (body.paypal_receiver ?? null) : null;
    const valid = await verifyTypedData({
      address: signer,
      ...settlementPreferenceTypedData({
        merchantId,
        rail: body.rail,
        paypalReceiver: paypalReceiver ?? "",
        nonce: BigInt(body.nonce),
        deadline: BigInt(body.deadline),
      }),
      signature: body.merchant_signature as Hex,
    });
    if (!valid) {
      return problem(
        c,
        403,
        "invalid-signature",
        "Invalid signature",
        "The signature is not the merchant's.",
      );
    }
    const stored = await deps.db
      .insert(merchantSettlement)
      .values({ merchantId, rail: body.rail, paypalReceiver, nonce: body.nonce })
      .onConflictDoUpdate({
        target: merchantSettlement.merchantId,
        set: { rail: body.rail, paypalReceiver, nonce: body.nonce, updatedAt: sql`now()` },
        setWhere: sql`${merchantSettlement.nonce} < ${body.nonce}::numeric`,
      })
      .returning({ merchantId: merchantSettlement.merchantId });
    if (stored.length === 0) {
      return problem(
        c,
        409,
        "nonce-used",
        "Nonce used",
        "The nonce is not higher than the one of the merchant's last choice.",
      );
    }
    return c.json(
      { rail: body.rail, ...(paypalReceiver ? { paypal_receiver: paypalReceiver } : {}) },
      200,
    );
  });
}
