import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CHAIN_IDS, KEELSON_TYPES, type KeelsonChainId, keelsonDomain } from "@keelson/core/eip712";
import { eq, purchases } from "@keelson/db";
import { concat, domainSeparator, hashStruct, keccak256 } from "viem";
import type { Deps } from "../app.ts";
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

export function registerValidations(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  app.openapi(route, async (c) => {
    const requestHash = c.req.valid("param").requestHash;
    const [row] = await deps.db
      .select({
        id: purchases.id,
        countersign: purchases.countersign,
        chainId: purchases.chainId,
        logIndex: purchases.logIndex,
      })
      .from(purchases)
      .where(eq(purchases.countersignDigest, Buffer.from(requestHash.slice(2), "hex")));
    if (!row?.countersign) {
      return problem(c, 404, "not-found", "Not found", "No countersign has this digest.");
    }
    const domain = keelsonDomain(
      (row.chainId ?? CHAIN_IDS.arbitrumSepolia) as KeelsonChainId,
      VERIFYING_CONTRACT,
    );
    const payload = concat([
      "0x1901",
      domainSeparator({ domain }),
      hashStruct({
        data: countersignMessage(row.countersign as CountersignJson),
        primaryType: "Countersign",
        types: KEELSON_TYPES,
      }),
    ]);
    if (keccak256(payload) !== requestHash) {
      throw new Error(`the stored countersign of purchase ${row.id} does not hash to its digest`);
    }
    c.header("Cache-Control", "public, max-age=300");
    return c.json(
      {
        payload,
        countersign: row.countersign,
        ...(row.logIndex === null ? {} : { alibi: `/v1/alibis/${row.id}` }),
      },
      200,
    );
  });
}
