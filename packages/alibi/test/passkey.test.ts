import { describe, expect, test } from "vitest";
import vectors from "../../mandate/test/vectors/webauthn.json" with { type: "json" };
import captures from "../../mandate/test/vectors/webauthn-captures.json" with { type: "json" };
import type { AlibiBundle } from "../src/schema.ts";
import { runCheck } from "../src/verify/check.ts";
import { passkey } from "../src/verify/checks/mandate.ts";
import { fixtures } from "./fixtures.ts";

interface Signed {
  payloadSd: Record<string, unknown>;
  disclosures: string[];
  commitment: string;
  assertion: { authenticatorData: string; clientDataJSON: string; signature: string };
}

/** The parts of a bundle the passkey check reads, for a signed mandate. */
const bundle = (s: Signed): AlibiBundle =>
  ({
    type: "keelson.alibi.v1",
    mandate: {
      payload_sd: s.payloadSd,
      disclosures: s.disclosures,
      user_auth: {
        authenticatorData: s.assertion.authenticatorData,
        clientDataJSON: s.assertion.clientDataJSON,
        signature: s.assertion.signature,
      },
    },
    tee: { countersign: { mandateCommitment: s.commitment } },
  }) as unknown as AlibiBundle;

const run = (s: Signed) => runCheck(passkey, bundle(s), {} as never);

/** The vector named `name`, as a signed mandate. */
const vector = (name: string): Signed => {
  const v = vectors.find((x) => x.name === `verify/${name}`)?.input as unknown as {
    payloadSd: Record<string, unknown>;
    disclosures: string[];
    cm: string;
    assertion: Signed["assertion"];
  };
  return {
    payloadSd: v.payloadSd,
    disclosures: v.disclosures,
    commitment: v.cm,
    assertion: v.assertion,
  };
};

describe("the passkey check", () => {
  test.each(fixtures.map((f) => [f.id, f.bundle] as const))(
    "passes %s, signed in the Keelson app, naming no platform",
    async (_, b) => {
      const check = await runCheck(passkey, b, {} as never);
      expect(check).toMatchObject({ status: "pass" });
      expect(check.detail).toBeUndefined();
    },
  );

  test("passes a mandate signed in the approval its platform framed, and names the platform", async () => {
    const check = await run(captures.framed.signed as Signed);
    expect(check).toMatchObject({
      status: "pass",
      detail: { signedOn: new URL(captures.framed.topOrigin).host },
    });
  });

  test.each([
    "synthetic/error/framed-cross-origin-false",
    "synthetic/error/framed-cross-origin-absent",
    "synthetic/error/framed-cross-origin-string",
    "synthetic/error/framed-top-origin-absent",
    "synthetic/error/framed-top-origin-slash",
    "synthetic/error/framed-top-origin-null",
    "synthetic/error/framed-payment-top-origin",
  ])("refuses %s before the signature", async (name) => {
    const check = await run(vector(name));
    expect(check.status).toBe("fail");
    expect(check.reason).toBe(
      `the assertion is not over this mandate's challenge from Keelson's approval framed by ${captures.framed.topOrigin}`,
    );
  });

  test("refuses a top-level assertion that names a top origin", async () => {
    const check = await run(vector("synthetic/error/top-origin"));
    expect(check.reason).toBe(
      "the assertion is not over this mandate's challenge from the Keelson app",
    );
  });

  test("refuses a framed assertion for a mandate signed without embed", async () => {
    const top = captures.signed.webauthn as Signed;
    const framed = captures.framed.signed as Signed;
    const check = await run({ ...top, assertion: framed.assertion });
    expect(check.status).toBe("fail");
    expect(check.reason).toBe(
      "the assertion is not over this mandate's challenge from the Keelson app",
    );
  });

  test("the synthetic framed payment.get passes the framing and fails only its test signature", async () => {
    const check = await run(vector("synthetic/ok/framed-payment.get"));
    expect(check.reason).toBe("the passkey signature does not verify");
  });
});
