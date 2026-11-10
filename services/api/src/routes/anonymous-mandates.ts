import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { deploymentsFor } from "@keelson/chain";
import { eq, mandates, userSetRoots } from "@keelson/db";
import { arbitrumSepolia } from "viem/chains";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Hex32 = z.string().regex(/^0x[0-9a-f]{64}$/);

const notFound = (what: string) => ({
  description: `No ${what}`,
  content: { "application/problem+json": { schema: ProblemSchema } },
});

const AnonymousMandateSchema = z
  .object({
    mandate_hash: Hex32.openapi({ description: "The passkey challenge `M` the user signed." }),
    mandate_commitment: Hex32.openapi({ description: "`C_m`, the commitment the mandate names." }),
    user_set_root: Hex32.openapi({
      description: "The registered-user tree the signer is a leaf of when the proof was made.",
    }),
    proof: z.string().openapi({ description: "The UltraHonk proof bytes, standard base64." }),
    public_inputs: z.array(Hex32).length(4).openapi({
      description:
        '`C_m, M mod r, user_set_root, SHA-256("keelson.finance")`: the calldata of `verify(bytes,bytes32[])`.',
    }),
    verifier: z.object({ chain_id: z.number().int(), address: z.string() }).optional().openapi({
      description:
        "The deployed verifier that accepts the proof in an `eth_call`. It checks the proof only: `public_inputs` must also be the countersign's `C_m` and `M`, Keelson's RP ID hash, and a root `GET /v1/user-set/roots/{root}` lists.",
    }),
  })
  .openapi("AnonymousMandate");

const anonymousRoute = createRoute({
  method: "get",
  path: "/v1/anonymous-mandates/{mandateHash}",
  tags: ["mandates"],
  summary: "Proof that a registered user signed a mandate",
  description:
    "The C3 `anonymous_mandate` zero-knowledge proof of the mandate whose passkey challenge is `mandateHash`, the `mandateHash` of its countersigns: a passkey in Keelson's registered-user tree signed it, and the mandate's commitment names that passkey. It shows neither the user nor the key, so it needs no authentication. Verify it with bb.js against the C3 key or with `eth_call` on `verifier`, and check `user_set_root` with `GET /v1/user-set/roots/{root}`.",
  request: { params: z.object({ mandateHash: Hex32 }) },
  responses: {
    200: {
      description: "The proof",
      content: { "application/json": { schema: AnonymousMandateSchema } },
    },
    404: notFound("proof for this mandate yet"),
  },
});

const RootSchema = z
  .object({
    root: Hex32,
    size: z
      .number()
      .int()
      .openapi({ description: "Registered users when the tree had this root." }),
    created_at: z.string().openapi({ format: "date-time" }),
  })
  .openapi("UserSetRoot");

const rootRoute = createRoute({
  method: "get",
  path: "/v1/user-set/roots/{root}",
  tags: ["mandates"],
  summary: "A root of the registered-user tree",
  description:
    "Whether `root` is, or was, the root of Keelson's registered-user tree: the Poseidon2 Merkle tree of every registered passkey's `user_key_hash`. A C3 proof under any root listed here was made by a registered user, who is hidden among the `size` users of that root. Roots stay valid after a passkey is removed.",
  request: { params: z.object({ root: Hex32 }) },
  responses: {
    200: { description: "The root", content: { "application/json": { schema: RootSchema } } },
    404: notFound("such root"),
  },
});

const hex = (b: Uint8Array): string => `0x${Buffer.from(b).toString("hex")}`;

export function registerAnonymousMandates(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
  const { db } = deps;

  app.openapi(anonymousRoute, async (c) => {
    const { mandateHash } = c.req.valid("param");
    const [row] = await db
      .select({ commitment: mandates.commitment, c3Proof: mandates.c3Proof })
      .from(mandates)
      .where(eq(mandates.mandateHash, Buffer.from(mandateHash.slice(2), "hex")));
    if (!row?.c3Proof || !row.commitment) {
      return problem(c, 404, "not-found", "Not found", "This mandate has no C3 proof yet.");
    }
    const verifier = deploymentsFor(arbitrumSepolia.id).AnonymousMandateVerifier;
    c.header("Cache-Control", "public, max-age=3600, immutable");
    return c.json(
      {
        mandate_hash: mandateHash,
        mandate_commitment: hex(row.commitment),
        user_set_root: row.c3Proof.public_inputs[2] as string,
        proof: row.c3Proof.proof,
        public_inputs: row.c3Proof.public_inputs,
        ...(verifier ? { verifier: { chain_id: arbitrumSepolia.id, address: verifier } } : {}),
      },
      200,
    );
  });

  app.openapi(rootRoute, async (c) => {
    const { root } = c.req.valid("param");
    const [row] = await db
      .select()
      .from(userSetRoots)
      .where(eq(userSetRoots.root, Buffer.from(root.slice(2), "hex")));
    if (!row)
      return problem(c, 404, "not-found", "Not found", "This is not a registered-user root.");
    c.header("Cache-Control", "public, max-age=3600, immutable");
    return c.json({ root, size: row.size, created_at: row.createdAt.toISOString() }, 200);
  });
}
