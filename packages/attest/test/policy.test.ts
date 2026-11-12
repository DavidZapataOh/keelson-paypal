import { describe, expect, test } from "vitest";
import { AttestError } from "../src/errors.ts";
import { appraiseTd, deviceIdOf, TDX_DEVICES } from "../src/policy.ts";
import { type TdxResult, verifyTdx } from "../src/tdx.ts";
import { tdxEvidence } from "./evidence.ts";

const att = tdxEvidence.attestation;
const verified = () =>
  verifyTdx(
    {
      quote: Buffer.from(att.quote, "hex"),
      eventLog: att.event_log,
      collateral: tdxEvidence.collateral,
    },
    { now: new Date(tdxEvidence.capturedAt) },
  );
const codeOf = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AttestError);
    return (e as AttestError).code;
  }
  return "passed";
};
/** The hex with bit `bit` of byte `byte` flipped. */
const flip = (hex: `0x${string}`, byte: number, bit: number): `0x${string}` => {
  const b = Buffer.from(hex.slice(2), "hex");
  b[byte] = (b[byte] as number) ^ (1 << bit);
  return `0x${b.toString("hex")}`;
};

describe("appraiseTd", () => {
  test("the TDX leg's captured quote passes, on its own device", async () => {
    const r = await verified();
    expect(r.tdAttributes).toBe("0x0000001000000000");
    expect(r.xfam).toBe("0x0702000000000000");
    expect(deviceIdOf(Buffer.from(r.ppid.slice(2), "hex"))).toBe(TDX_DEVICES[0]);
    expect(codeOf(() => appraiseTd(r))).toBe("passed");
  });

  test("each field off by one bit fails with its own code", async () => {
    const r = await verified();
    const with_ = (o: Partial<TdxResult>) => () => appraiseTd({ ...r, ...o });
    expect(codeOf(with_({ tdAttributes: flip(r.tdAttributes, 0, 0) }))).toBe("td_attributes");
    expect(codeOf(with_({ tdAttributes: flip(r.tdAttributes, 3, 4) }))).toBe("td_attributes");
    expect(codeOf(with_({ tdAttributes: flip(r.tdAttributes, 7, 0) }))).toBe("td_attributes");
    expect(codeOf(with_({ xfam: flip(r.xfam, 0, 3) }))).toBe("xfam");
    expect(codeOf(with_({ mrOwner: flip(r.mrOwner, 47, 0) }))).toBe("owner_fields");
    expect(codeOf(with_({ mrOwnerConfig: flip(r.mrOwnerConfig, 0, 0) }))).toBe("owner_fields");
    expect(codeOf(with_({ mrConfigId: flip(r.mrConfigId, 47, 0) }))).toBe("owner_fields");
    expect(codeOf(with_({ ppid: flip(r.ppid, 0, 0) }))).toBe("device");
  });

  test("MRCONFIGID: zero or a dstack version; version 1 names the attested compose hash", async () => {
    const r = await verified();
    const v1 = (hash: string) => `0x01${hash}${"00".repeat(15)}` as `0x${string}`;
    expect(codeOf(() => appraiseTd({ ...r, mrConfigId: `0x${"00".repeat(48)}` }))).toBe("passed");
    expect(codeOf(() => appraiseTd({ ...r, mrConfigId: v1(r.composeHash.slice(2)) }))).toBe(
      "passed",
    );
    expect(codeOf(() => appraiseTd({ ...r, mrConfigId: v1("ab".repeat(32)) }))).toBe(
      "owner_fields",
    );
    expect(
      codeOf(() => appraiseTd({ ...r, mrConfigId: `0x04${"11".repeat(32)}${"00".repeat(15)}` })),
    ).toBe("owner_fields");
  });

  test("a device off the list fails, and the list can be given", async () => {
    const r = await verified();
    expect(codeOf(() => appraiseTd(r, { devices: [] }))).toBe("device");
  });
});
