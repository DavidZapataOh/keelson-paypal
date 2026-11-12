import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Address, type Hex, keccak256 } from "viem";
import type { Deps } from "../app.ts";
import { requireClient } from "../middleware/auth.ts";
import { relay, relayedResponses } from "../onchain/respond.ts";

const Address_ = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Uint = z
  .string()
  .regex(/^(0|[1-9]\d{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n, "at most 256 bits");

const PayoutAddress = z
  .object({
    chainId: z.union([z.literal(421614), z.literal(42161)]),
    merchant: Address_,
    payout: Address_.openapi({
      description: "Where slashes and warranties for the merchant are paid.",
    }),
    nonce: Uint.openapi({ description: "`vault.nonces(merchant)`." }),
    deadline: Uint.openapi({ description: "Unix seconds." }),
    merchantSignature: z
      .string()
      .regex(/^0x([0-9a-fA-F]{2})+$/)
      .max(2 + 2 * 4096)
      .openapi({
        description: "The vault's EIP-712 `PayoutAddress`, by the merchant (EOA or ERC-1271).",
      }),
  })
  .openapi("PayoutAddress");

const route = createRoute({
  method: "post",
  path: "/v1/merchants/payout-address",
  operationId: "setPayoutAddress",
  tags: ["merchants"],
  summary: "Set a merchant's payout address, gasless",
  description: "Relays `setPayoutAddress` to the bond vault; Keelson pays the gas.",
  middleware: [requireClient(["merchants:write"])],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: PayoutAddress } } },
  },
  responses: relayedResponses,
});

export function registerMerchantsPayout(app: OpenAPIHono, deps: Pick<Deps, "relayer">): void {
  app.openapi(route, (c) => {
    const body = c.req.valid("json");
    return relay(c, deps.relayer, (relayer) =>
      relayer.submit({
        chainId: body.chainId,
        contract: "KeelsonBondVault",
        functionName: "setPayoutAddress",
        args: [
          body.merchant as Address,
          body.payout as Address,
          BigInt(body.nonce),
          BigInt(body.deadline),
          body.merchantSignature as Hex,
        ],
        key: `KeelsonBondVault.setPayoutAddress:${keccak256(body.merchantSignature as Hex)}`,
      }),
    );
  });
}
