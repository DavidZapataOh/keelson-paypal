import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { verdictVerifierAbi } from "@keelson/chain";
import { and, desc, gt, isNull, teeSigners } from "@keelson/db";
import { getAddress } from "viem";
import type { Deps } from "../app.ts";
import { loadMeasurements } from "../tee/measurements.ts";
import { ATTESTATION_MAX_AGE_MS } from "../tee/signers.ts";

const Leg = z
  .object({
    tee: z.enum(["tdx", "nitro"]),
    signer: z.string(),
    measurement: z.string(),
    registeredAt: z.string(),
    verifiedAt: z.string().openapi({ description: "When the attestation last verified." }),
    expiresAt: z.string(),
    onchain: z
      .object({
        chainId: z.number(),
        verdictVerifier: z.string(),
        registeredAt: z.string(),
        expiresAt: z.string(),
      })
      .nullable()
      .openapi({
        description:
          "The signer's record in the VerdictVerifier, which on-chain verification reads; null when it is not registered there.",
      }),
    attestation: z.record(z.string(), z.unknown()).openapi({
      description:
        "The attestation the signer was admitted from: the platform evidence, its binding and the block it was made over.",
    }),
  })
  .openapi("TeeLeg");

const route = createRoute({
  method: "get",
  path: "/v1/tee/attestations",
  operationId: "listTeeAttestations",
  tags: ["tee"],
  summary: "Attested TEE signers",
  description:
    "The signers whose countersignatures are accepted, each with the attestation it was admitted from, and the measurements the deployment publishes. A verifier checks the attestations itself.",
  responses: {
    200: {
      description: "The admitted signers and the published measurements",
      content: {
        "application/json": {
          schema: z.object({
            legs: z.array(Leg),
            measurements: z.object({
              engineBuildId: z.string(),
              tdx: z.array(z.string()),
              nitro: z.array(z.string()),
              provenance: z.string().openapi({
                description:
                  "Where the Sigstore build provenance attested measurements.json is published; `gh attestation verify` checks it.",
              }),
            }),
          }),
        },
      },
    },
  },
});

export function registerTee(app: OpenAPIHono, deps: Pick<Deps, "db" | "tee">): void {
  const chain = deps.tee?.chain;
  const onchain = async (signer: `0x${string}`) => {
    if (!chain) return null;
    const [, registeredAt, expiresAt] = await chain.public.readContract({
      address: chain.verdictVerifier,
      abi: verdictVerifierAbi,
      functionName: "signers",
      args: [signer],
    });
    if (registeredAt === 0) return null;
    return {
      chainId: await chain.public.getChainId(),
      verdictVerifier: chain.verdictVerifier,
      registeredAt: new Date(registeredAt * 1000).toISOString(),
      expiresAt: new Date(expiresAt * 1000).toISOString(),
    };
  };
  app.openapi(route, async (c) => {
    const rows = await deps.db
      .select()
      .from(teeSigners)
      .where(
        and(
          isNull(teeSigners.revokedAt),
          gt(teeSigners.expiresAt, new Date()),
          gt(teeSigners.verifiedAt, new Date(Date.now() - ATTESTATION_MAX_AGE_MS)),
        ),
      )
      .orderBy(teeSigners.teeKind, desc(teeSigners.registeredAt));
    const m = loadMeasurements();
    const seen = new Set<number>();
    const legs = await Promise.all(
      rows
        .filter((r) => !seen.has(r.teeKind) && seen.add(r.teeKind))
        .map(async (r) => {
          const signer = getAddress(`0x${r.address.toString("hex")}`);
          return {
            tee: r.teeKind === 1 ? ("tdx" as const) : ("nitro" as const),
            signer,
            measurement: r.measurement,
            registeredAt: r.registeredAt.toISOString(),
            verifiedAt: r.verifiedAt.toISOString(),
            expiresAt: r.expiresAt.toISOString(),
            onchain: await onchain(signer),
            attestation: r.attestation as Record<string, unknown>,
          };
        }),
    );
    c.header("Cache-Control", "public, max-age=30");
    return c.json(
      {
        legs,
        measurements: {
          engineBuildId: m.engineBuildId,
          tdx: m.tdx,
          nitro: m.nitro,
          provenance: m.provenance,
        },
      },
      200,
    );
  });
}
