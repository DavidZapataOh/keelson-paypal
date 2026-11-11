import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { addresses, keelsonValidationRegistryAbi } from "@keelson/chain";
import { CHAIN_IDS, KEELSON_TYPES, type KeelsonChainId, keelsonDomain } from "@keelson/core/eip712";
import { eq, purchases } from "@keelson/db";
import { erc8004ChainIds } from "@keelson/erc8004";
import { concat, decodeFunctionData, domainSeparator, type Hex, hashStruct, keccak256 } from "viem";
import type { Deps } from "../app.ts";
import { ERC8004_DEPLOY_BLOCK } from "../chain/reader.ts";
import { ProblemSchema, problem } from "../problem.ts";
import type { CountersignJson } from "../tee/client.ts";
import { VERIFYING_CONTRACT } from "../tee/config.ts";
import { countersignMessage } from "../tee/coordinator.ts";

const Validation = z
  .object({
    payload: z.string().openapi({
      description:
        "`0x1901 ‖ domainSeparator ‖ hashStruct(Countersign)`; its keccak256 is the request hash.",
    }),
    countersign: z
      .record(z.string(), z.string())
      .openapi({ description: "The EIP-712 `Countersign` message, as decimal strings." }),
    alibi: z.string().optional().openapi({ description: "The purchase's Alibi, once logged." }),
  })
  .openapi("ValidationRequest", {
    description: "The data of an ERC-8004 validation request Keelson records for a countersign.",
  });

const route = createRoute({
  method: "get",
  path: "/v1/validations/{requestHash}",
  operationId: "getValidation",
  tags: ["validations"],
  summary: "Validation request of a countersign",
  description:
    "What the `requestURI` of a Keelson validation request points to: the countersign whose EIP-712 digest, under the VerdictVerifier domain, is `requestHash`.",
  request: {
    params: z.object({
      requestHash: z
        .string()
        .regex(/^0x[0-9a-f]{64}$/)
        .openapi({ description: "The countersign digest, 32 bytes of lowercase hex." }),
    }),
  },
  responses: {
    200: {
      description: "The validation request",
      headers: z.object({ "Cache-Control": z.string() }),
      content: { "application/json": { schema: Validation } },
    },
    404: {
      description: "No countersign has this digest",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

/** `0x1901 ‖ domainSeparator ‖ hashStruct(Countersign)` under the VerdictVerifier domain the legs sign with. */
function payloadOf(countersign: CountersignJson, chainId: KeelsonChainId): Hex {
  return concat([
    "0x1901",
    domainSeparator({ domain: keelsonDomain(chainId, VERIFYING_CONTRACT) }),
    hashStruct({
      data: countersignMessage(countersign),
      primaryType: "Countersign",
      types: KEELSON_TYPES,
    }),
  ]);
}

export function registerValidations(app: OpenAPIHono, deps: Pick<Deps, "db" | "chains">): void {
  /** The countersign of a validation recorded on-chain, from the calldata of the transaction that recorded it. */
  async function recordedCountersign(requestHash: Hex): Promise<CountersignJson | null> {
    for (const chainId of erc8004ChainIds) {
      const registry = addresses[chainId].KeelsonValidationRegistry;
      const reader = deps.chains?.[chainId];
      if (!registry || !reader) continue;
      const [request] = await reader.logs.getContractEvents({
        address: registry,
        abi: keelsonValidationRegistryAbi,
        eventName: "ValidationRequest",
        args: { requestHash },
        fromBlock: ERC8004_DEPLOY_BLOCK[chainId],
        toBlock: "latest",
      });
      if (!request) continue;
      const tx = await reader.client.getTransaction({ hash: request.transactionHash });
      try {
        const call = decodeFunctionData({ abi: keelsonValidationRegistryAbi, data: tx.input });
        if (call.functionName !== "recordCountersign") continue;
        const countersign = Object.fromEntries(
          Object.entries(call.args[0]).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]),
        ) as unknown as CountersignJson;
        if (keccak256(payloadOf(countersign, CHAIN_IDS.arbitrumSepolia)) === requestHash) {
          return countersign;
        }
      } catch {
        // Recorded through another contract: the calldata is not the registry's.
      }
    }
    return null;
  }

  app.openapi(route, async (c) => {
    const requestHash = c.req.valid("param").requestHash;
    const [row] = await deps.db
      .select({
        id: purchases.id,
        countersign: purchases.countersign,
        logIndex: purchases.logIndex,
      })
      .from(purchases)
      .where(eq(purchases.countersignDigest, Buffer.from(requestHash.slice(2), "hex")));
    const countersign =
      (row?.countersign as CountersignJson | null | undefined) ??
      (await recordedCountersign(requestHash as Hex));
    if (!countersign) {
      return problem(c, 404, "not-found", "Not found", "No countersign has this digest.");
    }
    // The legs sign every countersign under the Arbitrum Sepolia domain, whichever chain records it.
    const payload = payloadOf(countersign, CHAIN_IDS.arbitrumSepolia);
    if (keccak256(payload) !== requestHash) {
      throw new Error(`the stored countersign of purchase ${row?.id} does not hash to its digest`);
    }
    c.header("Cache-Control", "public, max-age=300");
    return c.json(
      {
        payload,
        countersign,
        ...(row && row.logIndex !== null ? { alibi: `/v1/alibis/${row.id}` } : {}),
      },
      200,
    );
  });
}
