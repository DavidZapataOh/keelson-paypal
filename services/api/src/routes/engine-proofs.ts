import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { disputes, eq, purchases } from "@keelson/db";
import { CHAINS, isChainId } from "@keelson/relayer";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const EngineProofSchema = z
  .object({
    purchase_id: z.string(),
    status: z.enum(["proven", "proving"]).openapi({
      description:
        "`proving`: the purchase is disputed and its proof is being made. `proven`: the proof is recorded on chain.",
    }),
    countersign_eval_hash: Hex32.openapi({ description: "The `evalHash` both TEE legs signed." }),
    countersign_digest: Hex32.openapi({ description: "The EIP-712 digest of their countersign." }),
    proof: z
      .object({
        eval_hash: Hex32.openapi({
          description: "The `evalHash` the engine program computed in the SP1 zkVM.",
        }),
        matches: z.boolean().openapi({
          description: "Whether `eval_hash` is the countersign's and the proof is of its digest.",
        }),
        public_values: z
          .string()
          .openapi({ description: "`abi.encode(evalHash, countersignDigest)`." }),
        proof: z.string().openapi({ description: "The SP1 Groth16 proof bytes, hex." }),
        vkey: Hex32.openapi({ description: "The engine program's SP1 verifying key." }),
        sp1_version: z.string(),
        cycles: z.number().int(),
        prove_ms: z.number().int(),
        proof_bytes: z.number().int(),
        verifier: z.object({ chain_id: z.number().int(), address: z.string() }).openapi({
          description:
            "The `EngineProofVerifier` that verified the proof through Succinct's SP1 verifier gateway; `verify(public_values, proof)` checks it again in an `eth_call`, `proven(countersign_digest)` returns the recorded `eval_hash`.",
        }),
        tx: z.string().openapi({ description: "The `EngineProofVerifier.record` transaction." }),
        explorer_url: z.string().nullable(),
        gas_used: z.string(),
        proven_at: z.iso.datetime(),
      })
      .nullable(),
  })
  .openapi("EngineProof");

const route = createRoute({
  method: "get",
  path: "/v1/engine-proofs/{id}",
  tags: ["purchases"],
  summary: "SP1 proof of a purchase's engine evaluation",
  description:
    "For a disputed purchase, an SP1 Groth16 proof that the engine's own canonicalizer and Cedar evaluation, run again in the SP1 zkVM over the purchase's stored inputs, give the `evalHash` both TEE legs signed, and the transaction that verified it on chain through Succinct's SP1 verifier gateway. It holds only hashes and the proof, so it needs no authentication.",
  request: { params: z.object({ id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/) }) },
  responses: {
    200: {
      description: "The proof",
      content: { "application/json": { schema: EngineProofSchema } },
    },
    404: {
      description: "No dispute over this purchase, or no inputs kept to prove it",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerEngineProofs(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  const { db } = deps;
  app.openapi(route, async (c) => {
    const { id } = c.req.valid("param");
    const [row] = await db
      .select({
        countersign: purchases.countersign,
        digest: purchases.countersignDigest,
        input: purchases.engineInput,
        proof: purchases.engineProof,
        disputeId: disputes.id,
      })
      .from(purchases)
      .leftJoin(disputes, eq(disputes.purchaseId, purchases.id))
      .where(eq(purchases.id, id))
      .limit(1);
    if (!row?.countersign || !row.digest || (!row.proof && !(row.disputeId && row.input))) {
      return problem(c, 404, "not-found", "Not found", "This purchase has no engine proof.");
    }
    const evalHash = row.countersign.evalHash as string;
    const digest = `0x${Buffer.from(row.digest).toString("hex")}`;
    const p = row.proof;
    c.header("Cache-Control", p ? "public, max-age=3600" : "no-store");
    return c.json(
      {
        purchase_id: id,
        status: p ? ("proven" as const) : ("proving" as const),
        countersign_eval_hash: evalHash,
        countersign_digest: digest,
        proof: p
          ? {
              eval_hash: p.eval_hash,
              matches: p.eval_hash === evalHash && p.countersign_digest === digest,
              public_values: p.public_values,
              proof: p.proof,
              vkey: p.vkey,
              sp1_version: p.sp1_version,
              cycles: p.cycles,
              prove_ms: p.prove_ms,
              proof_bytes: p.proof_bytes,
              verifier: { chain_id: p.chain_id, address: p.verifier },
              tx: p.tx,
              explorer_url: isChainId(p.chain_id)
                ? `${CHAINS[p.chain_id].explorer}/tx/${p.tx}`
                : null,
              gas_used: p.gas_used,
              proven_at: p.proven_at,
            }
          : null,
      },
      200,
    );
  });
}
