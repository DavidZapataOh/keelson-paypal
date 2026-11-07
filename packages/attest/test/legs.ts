import type { Json } from "@keelson/core";
import { nitroMeasurement, tdxMeasurement } from "../src/measurement.ts";
import { verifyNitro } from "../src/nitro.ts";
import type { Expectations, SignerAttestation } from "../src/signer.ts";
import { verifyTdx } from "../src/tdx.ts";
import { nitroEvidence, tdxEvidence } from "./evidence.ts";

/** Both captured legs with the expectations of their capture. */
export async function legs(): Promise<
  [[SignerAttestation, Expectations], [SignerAttestation, Expectations]]
> {
  const a = tdxEvidence.attestation;
  const b = nitroEvidence.attestation;
  const tdxNow = new Date(tdxEvidence.capturedAt);
  const nitroNow = new Date(nitroEvidence.capturedAt);
  const tdx = await verifyTdx(
    {
      quote: Buffer.from(a.quote, "hex"),
      eventLog: a.event_log,
      collateral: tdxEvidence.collateral,
    },
    { now: tdxNow },
  );
  const nitro = await verifyNitro(Buffer.from(b.document, "base64"), { now: nitroNow });
  const expectation = (
    binding: typeof a.binding,
    measurement: string,
    now: Date,
  ): Expectations => ({
    chainId: Number(binding.chainId),
    bondVault: binding.bondVault,
    policySetHash: binding.policySetHash,
    engineBuildId: binding.engineBuildId,
    measurements: [measurement],
    now,
  });
  return [
    [
      {
        tee: "tdx",
        quote: a.quote,
        eventLog: a.event_log,
        collateral: tdxEvidence.collateral,
        binding: a.binding,
        block: a.block,
      },
      expectation(a.binding, tdxMeasurement(tdx), tdxNow),
    ],
    [
      { tee: "nitro", document: b.document, binding: b.binding, block: b.block },
      expectation(b.binding, nitroMeasurement(nitro), nitroNow),
    ],
  ];
}

/** The JSON a result serializes to, with bigint as decimal strings. */
export function plain(value: unknown): Json {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}
