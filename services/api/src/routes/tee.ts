import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
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
    expiresAt: z.string(),
    attestation: z.record(z.string(), z.unknown()).openapi({
      description:
        "The attestation the signer was admitted from: the platform evidence, its binding and the block it was made over.",
    }),
  })
  .openapi("TeeLeg");

const route = createRoute({
  method: "get",
  path: "/v1/tee/attestations",
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
            }),
          }),
        },
      },
    },
  },
});

export function registerTee(app: OpenAPIHono, deps: Pick<Deps, "db">): void {
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
    const legs = rows
      .filter((r) => !seen.has(r.teeKind) && seen.add(r.teeKind))
      .map((r) => ({
        tee: r.teeKind === 1 ? ("tdx" as const) : ("nitro" as const),
        signer: getAddress(`0x${r.address.toString("hex")}`),
        measurement: r.measurement,
        registeredAt: r.registeredAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
        attestation: r.attestation as Record<string, unknown>,
      }));
    return c.json(
      { legs, measurements: { engineBuildId: m.engineBuildId, tdx: m.tdx, nitro: m.nitro } },
      200,
    );
  });
}
