import { describe, expect, test } from "vitest";
import { AttestError } from "../src/errors.ts";
import { verifyNitro } from "../src/nitro.ts";
import { verifyTdx } from "../src/tdx.ts";
import { nitroEvidence, tdxEvidence } from "./evidence.ts";

const tdxInput = (collateral = tdxEvidence.collateral) => ({
  quote: Buffer.from(tdxEvidence.attestation.quote, "hex"),
  eventLog: tdxEvidence.attestation.event_log,
  collateral,
});
const nitroDocument = Buffer.from(nitroEvidence.attestation.document, "base64");
const tdxNow = new Date(tdxEvidence.capturedAt);
const nitroNow = new Date(nitroEvidence.capturedAt);
const after = (d: Date) => new Date(d.getTime() + 1000);
const before = (d: Date) => new Date(d.getTime() - 1000);

const codeOf = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AttestError);
  return (error as AttestError).code;
};

describe("validity of a verified TDX quote", () => {
  test("contains the time it was verified at and ends no later than the collateral", async () => {
    const { validity } = await verifyTdx(tdxInput(), { now: tdxNow });
    expect(validity.notBefore.getTime()).toBeLessThanOrEqual(tdxNow.getTime());
    expect(validity.notAfter.getTime()).toBeGreaterThanOrEqual(tdxNow.getTime());
    for (const json of [tdxEvidence.collateral.tcb_info, tdxEvidence.collateral.qe_identity]) {
      const { issueDate, nextUpdate } = JSON.parse(json) as {
        issueDate: string;
        nextUpdate: string;
      };
      expect(validity.notBefore.getTime()).toBeGreaterThanOrEqual(Date.parse(issueDate));
      expect(validity.notAfter.getTime()).toBeLessThanOrEqual(Date.parse(nextUpdate));
    }
  });

  test("the quote verifies at both ends of it and not past its end", async () => {
    const { validity } = await verifyTdx(tdxInput(), { now: tdxNow });
    await expect(verifyTdx(tdxInput(), { now: validity.notBefore })).resolves.toBeDefined();
    await expect(verifyTdx(tdxInput(), { now: validity.notAfter })).resolves.toBeDefined();
    expect(await codeOf(verifyTdx(tdxInput(), { now: after(validity.notAfter) }))).toBe(
      "collateral_expired",
    );
    expect(await codeOf(verifyTdx(tdxInput(), { now: before(validity.notBefore) }))).toBe(
      "collateral_expired",
    );
  });

  test("is the same when the CRLs come as hex", async () => {
    const hex = (v: unknown) => Buffer.from(v as number[]).toString("hex");
    const collateral = {
      ...tdxEvidence.collateral,
      root_ca_crl: hex(tdxEvidence.collateral.root_ca_crl),
      pck_crl: hex(tdxEvidence.collateral.pck_crl),
    } as unknown as typeof tdxEvidence.collateral;
    const bytes = await verifyTdx(tdxInput(), { now: tdxNow });
    const hexed = await verifyTdx(tdxInput(collateral), { now: tdxNow });
    expect(hexed.validity).toEqual(bytes.validity);
  });
});

describe("validity of a verified Nitro document", () => {
  test("contains the time it was verified at", async () => {
    const { validity } = await verifyNitro(nitroDocument, { now: nitroNow });
    expect(validity.notBefore.getTime()).toBeLessThanOrEqual(nitroNow.getTime());
    expect(validity.notAfter.getTime()).toBeGreaterThanOrEqual(nitroNow.getTime());
  });

  test("the document verifies at both ends of it and not past its end", async () => {
    const { validity } = await verifyNitro(nitroDocument, { now: nitroNow });
    await expect(verifyNitro(nitroDocument, { now: validity.notBefore })).resolves.toBeDefined();
    await expect(verifyNitro(nitroDocument, { now: validity.notAfter })).resolves.toBeDefined();
    expect(await codeOf(verifyNitro(nitroDocument, { now: after(validity.notAfter) }))).toBe(
      "cert_chain",
    );
  });
});
