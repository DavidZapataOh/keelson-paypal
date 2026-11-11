import { beforeEach, describe, expect, test, vi } from "vitest";
import { AttestationCache } from "../src/cache.ts";
import { AttestError } from "../src/errors.ts";
import { nitroMeasurement, tdxMeasurement } from "../src/measurement.ts";
import { verifyNitro } from "../src/nitro.ts";
import { type Expectations, type SignerAttestation, verifySigner } from "../src/signer.ts";
import { verifyTdx } from "../src/tdx.ts";
import { nitroEvidence, tdxEvidence } from "./evidence.ts";

vi.mock("../src/tdx.ts", async (original) => {
  const real = await original<typeof import("../src/tdx.ts")>();
  return { ...real, verifyTdx: vi.fn(real.verifyTdx) };
});
vi.mock("../src/nitro.ts", async (original) => {
  const real = await original<typeof import("../src/nitro.ts")>();
  return { ...real, verifyNitro: vi.fn(real.verifyNitro) };
});

const tdxAtt: SignerAttestation = {
  tee: "tdx",
  quote: tdxEvidence.attestation.quote,
  eventLog: tdxEvidence.attestation.event_log,
  collateral: tdxEvidence.collateral,
  binding: tdxEvidence.attestation.binding,
  block: tdxEvidence.attestation.block,
};
const nitroAtt: SignerAttestation = {
  tee: "nitro",
  document: nitroEvidence.attestation.document,
  binding: nitroEvidence.attestation.binding,
  block: nitroEvidence.attestation.block,
};
const legs = [
  { att: tdxAtt, now: new Date(tdxEvidence.capturedAt), platform: vi.mocked(verifyTdx) },
  { att: nitroAtt, now: new Date(nitroEvidence.capturedAt), platform: vi.mocked(verifyNitro) },
] as const;

async function platformOf(att: SignerAttestation, now: Date) {
  return att.tee === "tdx"
    ? verifyTdx(
        {
          quote: Buffer.from(att.quote, "hex"),
          eventLog: att.eventLog,
          collateral: att.collateral,
        },
        { now },
      )
    : verifyNitro(Buffer.from(att.document, "base64"), { now });
}

async function setup(att: SignerAttestation, now: Date) {
  const verified = await platformOf(att, now);
  const measurement =
    att.tee === "tdx"
      ? tdxMeasurement(verified as Awaited<ReturnType<typeof verifyTdx>>)
      : nitroMeasurement(verified as Awaited<ReturnType<typeof verifyNitro>>);
  const expect: Expectations = {
    chainId: Number(att.binding.chainId),
    bondVault: att.binding.bondVault,
    policySetHash: att.binding.policySetHash,
    engineBuildId: att.binding.engineBuildId,
    measurements: [measurement],
    now,
    cache: new AttestationCache(),
  };
  vi.mocked(verifyTdx).mockClear();
  vi.mocked(verifyNitro).mockClear();
  return { expect, measurement, validity: verified.validity };
}

const codeOf = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AttestError);
  return (error as AttestError).code;
};

/** The attestation with one byte of its quote or document flipped. */
function flipped(att: SignerAttestation): SignerAttestation {
  if (att.tee === "tdx") {
    const quote = Buffer.from(att.quote, "hex");
    quote[700] = (quote[700] as number) ^ 1;
    return { ...att, quote: quote.toString("hex") };
  }
  const document = Buffer.from(att.document, "base64");
  const last = document.length - 1;
  document[last] = (document[last] as number) ^ 1;
  return { ...att, document: document.toString("base64") };
}

beforeEach(() => {
  vi.mocked(verifyTdx).mockClear();
  vi.mocked(verifyNitro).mockClear();
});

describe.each(legs.map((l) => [l.att.tee, l] as const))("AttestationCache, %s", (_, leg) => {
  test("a cache hit skips the platform verification", async () => {
    const { expect: e } = await setup(leg.att, leg.now);
    const first = await verifySigner(leg.att, e);
    const second = await verifySigner(leg.att, e);
    expect(second).toEqual(first);
    expect(leg.platform).toHaveBeenCalledTimes(1);
  });

  test("a now past the window verifies in full and fails", async () => {
    const { expect: e, validity } = await setup(leg.att, leg.now);
    await verifySigner(leg.att, e);
    const late = new Date(validity.notAfter.getTime() + 1000);
    expect(["collateral_expired", "cert_chain"]).toContain(
      await codeOf(verifySigner(leg.att, { ...e, now: late })),
    );
    expect(leg.platform).toHaveBeenCalledTimes(2);
  });

  test("a now before the window verifies in full and fails", async () => {
    const { expect: e, validity } = await setup(leg.att, leg.now);
    await verifySigner(leg.att, e);
    const early = new Date(validity.notBefore.getTime() - 1000);
    expect(["collateral_expired", "cert_chain"]).toContain(
      await codeOf(verifySigner(leg.att, { ...e, now: early })),
    );
    expect(leg.platform).toHaveBeenCalledTimes(2);
  });

  test("a changed measurement allowlist verifies in full", async () => {
    const { expect: e, measurement } = await setup(leg.att, leg.now);
    const other = `${leg.att.tee}:${"0".repeat(64)}`;
    await verifySigner(leg.att, e);
    await verifySigner(leg.att, { ...e, measurements: [other, measurement] });
    expect(leg.platform).toHaveBeenCalledTimes(2);
    expect(await codeOf(verifySigner(leg.att, { ...e, measurements: [other] }))).toBe(
      "measurement_not_allowed",
    );
    expect(leg.platform).toHaveBeenCalledTimes(3);
  });

  test("a different document verifies in full and fails", async () => {
    const { expect: e } = await setup(leg.att, leg.now);
    await verifySigner(leg.att, e);
    await expect(verifySigner(flipped(leg.att), e)).rejects.toBeInstanceOf(AttestError);
    expect(leg.platform).toHaveBeenCalledTimes(2);
  });

  test("the binding is checked on a hit", async () => {
    const { expect: e } = await setup(leg.att, leg.now);
    await verifySigner(leg.att, e);
    const otherVault = "0x000000000000000000000000000000000000dEaD";
    expect(await codeOf(verifySigner(leg.att, { ...e, bondVault: otherVault }))).toBe(
      "binding_mismatch",
    );
    expect(leg.platform).toHaveBeenCalledTimes(1);
  });

  test("without a cache every call verifies", async () => {
    const { expect: e } = await setup(leg.att, leg.now);
    const { cache: _, ...uncached } = e;
    await verifySigner(leg.att, uncached);
    await verifySigner(leg.att, uncached);
    expect(leg.platform).toHaveBeenCalledTimes(2);
  });
});

test("the cache keeps at most max entries, dropping the oldest", async () => {
  const cache = new AttestationCache(1);
  const tdx = await setup(tdxAtt, legs[0].now);
  const nitro = await setup(nitroAtt, legs[1].now);
  await verifySigner(tdxAtt, { ...tdx.expect, cache });
  await verifySigner(nitroAtt, { ...nitro.expect, cache });
  await verifySigner(tdxAtt, { ...tdx.expect, cache });
  expect(verifyTdx).toHaveBeenCalledTimes(2);
});
