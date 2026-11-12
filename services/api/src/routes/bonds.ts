import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { MiddlewareHandler } from "hono";
import { type Address, encodeAbiParameters, getAddress, type Hex, keccak256 } from "viem";
import type { Deps } from "../app.ts";
import { requireClient, requirePrincipal } from "../middleware/auth.ts";
import { relay, relayedResponses } from "../onchain/respond.ts";
import { problem } from "../problem.ts";
import { operatorWallets } from "./operator-console.ts";

/** An `operators:write` client, or a signed-in user whose wallets the handler checks. */
const clientOrOperatorSession: MiddlewareHandler = (c, next) =>
  c.var.principal?.kind === "user" && !c.var.invalidToken
    ? next()
    : requireClient(["operators:write"])(c, next);

const MAX_AGENT_ID = 2n ** 64n - 1n;
const UINT = /^(0|[1-9]\d{0,77})$/;

const Uint = (description: string, bits = 256) =>
  z
    .string()
    .regex(UINT)
    .refine((v) => BigInt(v) < 2n ** BigInt(bits), `at most ${bits} bits`)
    .openapi({ description });
const Address_ = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const Bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const Signature = z
  .string()
  .regex(/^0x([0-9a-fA-F]{2})+$/)
  .max(2 + 2 * 4096);
const RelayChain = z
  .union([z.literal(421614), z.literal(42161)])
  .openapi({ description: "Arbitrum Sepolia (421614) or Arbitrum One (42161)." });
const AgentId = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .refine((v) => BigInt(v) <= MAX_AGENT_ID, "agent ids are at most 2^64 - 1")
  .openapi({ description: "The ERC-8004 agent id, a decimal integer." });
const idempotencyHeader = z.object({ "idempotency-key": z.string().min(1).max(255) });

const Deposit = z
  .discriminatedUnion("kind", [
    z.object({
      chainId: RelayChain,
      kind: z.literal("authorization"),
      from: Address_,
      amount: Uint("PYUSD base units."),
      validAfter: Uint("Unix seconds."),
      validBefore: Uint("Unix seconds."),
      salt: Bytes32.openapi({
        description:
          "The EIP-3009 nonce is `keccak256(abi.encode(agentId, salt))`, so the authorization credits only this agent.",
      }),
      signature: Signature.openapi({
        description: "PYUSD's EIP-3009 `ReceiveWithAuthorization` to the vault, signed by `from`.",
      }),
    }),
    z.object({
      chainId: RelayChain,
      kind: z.literal("permit"),
      owner: Address_.openapi({ description: "The agent's owner or agent wallet." }),
      amount: Uint("PYUSD base units."),
      deadline: Uint("Unix seconds."),
      signature: Signature.openapi({ description: "PYUSD's EIP-2612 permit to the vault." }),
    }),
  ])
  .openapi("BondDeposit");

const Withdrawal = z
  .object({
    chainId: RelayChain,
    amount: Uint("PYUSD base units.", 128),
    to: Address_,
    nonce: Uint("`vault.nonces(signer)`."),
    deadline: Uint("Unix seconds."),
    ownerSignature: Signature.openapi({
      description: "The vault's EIP-712 `WithdrawalRequest`, by the agent's owner or agent wallet.",
    }),
  })
  .openapi("BondWithdrawal");

const deposit = createRoute({
  method: "post",
  path: "/v1/bonds/{agentId}/deposits",
  operationId: "depositBond",
  tags: ["bonds"],
  summary: "Deposit PYUSD into an operator's bond, gasless",
  description:
    "Relays `depositWithAuthorization` (EIP-3009) or `depositWithPermit` (EIP-2612) to the bond vault; Keelson pays the gas. The same authorization is sent once, whatever the idempotency key. An `operators:write` client sends either; the operator's own session (EIP-4361, from the operator console) sends a permit whose `owner` is a wallet it signed in with that owns the agent.",
  middleware: [clientOrOperatorSession],
  request: {
    params: z.object({ agentId: AgentId }),
    headers: idempotencyHeader,
    body: { required: true, content: { "application/json": { schema: Deposit } } },
  },
  responses: relayedResponses,
});

const withdraw = createRoute({
  method: "post",
  path: "/v1/bonds/{agentId}/withdrawals",
  operationId: "queueBondWithdrawal",
  tags: ["bonds"],
  summary: "Queue a bond withdrawal, gasless",
  description:
    "Relays `requestWithdrawal`; the funds stay slashable until the withdrawal delay ends and it is completed.",
  middleware: [requireClient(["operators:write"])],
  request: {
    params: z.object({ agentId: AgentId }),
    headers: idempotencyHeader,
    body: { required: true, content: { "application/json": { schema: Withdrawal } } },
  },
  responses: relayedResponses,
});

const complete = createRoute({
  method: "post",
  path: "/v1/bonds/withdrawals/{chainId}/{withdrawalId}/complete",
  operationId: "completeBondWithdrawal",
  tags: ["bonds"],
  summary: "Complete a queued withdrawal, gasless",
  description:
    "Relays `completeWithdrawal`, which anyone may call once the delay ended; it pays only the signed recipient.",
  middleware: [requirePrincipal()],
  request: {
    params: z.object({
      chainId: z.enum(["421614", "42161"]),
      withdrawalId: z.string().regex(/^[1-9]\d{0,19}$/),
    }),
    headers: idempotencyHeader,
  },
  responses: relayedResponses,
});

export function registerBonds(
  app: OpenAPIHono,
  deps: Pick<Deps, "relayer" | "db" | "chains">,
): void {
  const walletsFor = operatorWallets(deps);
  app.openapi(deposit, async (c) => {
    const agentId = BigInt(c.req.valid("param").agentId);
    const body = c.req.valid("json");
    const principal = c.var.principal;
    if (principal?.kind === "user") {
      const wallets = await walletsFor(principal.subject, agentId);
      if (body.kind !== "permit" || !wallets.includes(getAddress(body.owner))) {
        return problem(
          c,
          403,
          "not-operator",
          "Not this operator",
          "A session deposits only a permit signed by one of its wallets that owns the agent.",
        ) as never;
      }
    }
    return relay(c, deps.relayer, (relayer) => {
      if (body.kind === "authorization") {
        const nonce = keccak256(
          encodeAbiParameters(
            [{ type: "uint256" }, { type: "bytes32" }],
            [agentId, body.salt as Hex],
          ),
        );
        return relayer.submit({
          chainId: body.chainId,
          contract: "KeelsonBondVault",
          functionName: "depositWithAuthorization",
          args: [
            agentId,
            body.from as Address,
            BigInt(body.amount),
            BigInt(body.validAfter),
            BigInt(body.validBefore),
            body.salt as Hex,
            body.signature as Hex,
          ],
          key: `KeelsonBondVault.deposit:${nonce}`,
        });
      }
      return relayer.submit({
        chainId: body.chainId,
        contract: "KeelsonBondVault",
        functionName: "depositWithPermit",
        args: [
          agentId,
          body.owner as Address,
          BigInt(body.amount),
          BigInt(body.deadline),
          body.signature as Hex,
        ],
        key: `KeelsonBondVault.depositWithPermit:${keccak256(body.signature as Hex)}`,
      });
    });
  });

  app.openapi(withdraw, (c) => {
    const agentId = BigInt(c.req.valid("param").agentId);
    const body = c.req.valid("json");
    return relay(c, deps.relayer, (relayer) =>
      relayer.submit({
        chainId: body.chainId,
        contract: "KeelsonBondVault",
        functionName: "requestWithdrawal",
        args: [
          agentId,
          BigInt(body.amount),
          body.to as Address,
          BigInt(body.nonce),
          BigInt(body.deadline),
          body.ownerSignature as Hex,
        ],
        key: `KeelsonBondVault.requestWithdrawal:${keccak256(body.ownerSignature as Hex)}`,
      }),
    );
  });

  app.openapi(complete, (c) => {
    const { chainId, withdrawalId } = c.req.valid("param");
    return relay(c, deps.relayer, (relayer) =>
      relayer.submit({
        chainId: Number(chainId) as 421614 | 42161,
        contract: "KeelsonBondVault",
        functionName: "completeWithdrawal",
        args: [BigInt(withdrawalId)],
        key: `KeelsonBondVault.completeWithdrawal:${withdrawalId}`,
      }),
    );
  });
}
