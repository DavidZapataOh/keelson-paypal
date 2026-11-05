import { decodeMandate, type Mandate, spcDetails } from "@keelson/mandate";
import type { SignedChallenge } from "@keelson/mandate/browser";
import { expect, test } from "vitest";
import vectors from "../../../packages/mandate/test/vectors/webauthn.json" with { type: "json" };
import { verifyMandateSignature } from "../src/mandate-signature.ts";
import type { Passkey } from "../src/passkeys.ts";

// The Rust verifier checks the same file; each kind maps to the message this verifier gives.
// Vectors scoped to Rust carry inputs a COSE passkey cannot express, such as compressed points.
const messages: Record<string, RegExp> = {
  "client-data": /clientDataJSON is (not a JSON object|too large)/,
  type: /Unexpected authentication response type/,
  challenge: /Unexpected authentication response challenge/,
  origin: /Unexpected authentication response origin/,
  "cross-origin": /cross-origin assertion/,
  "token-binding": /token binding/,
  payment: /payment data differs from the mandate/,
  "authenticator-data":
    /authenticatorData (is too large|has extension or credential data|is not 37 bytes)/,
  "rp-id": /Unexpected RP ID hash/,
  "user-present": /User not present/,
  "user-verified": /User verification required/,
  "backup-state": /backed up/,
  signature: /signature (did not verify|is too large)/,
};

interface VerifyInput {
  payloadSd: Record<string, unknown>;
  disclosures: string[];
  cm: string;
  origin: string;
  rpId: string;
  publicKey: string;
  assertion: SignedChallenge;
}

const cases = vectors.filter(
  (v) => v.input.op === "verify" && !("scope" in v && v.scope === "rust"),
);

test("the webauthn vectors cover every check", () => {
  expect(new Set(cases.map((v) => v.expected))).toEqual(new Set(["ok", ...Object.keys(messages)]));
});

test.each(cases.map((v) => [v.name, v.input as VerifyInput, v.expected as string] as const))(
  "%s",
  async (_, input, expected) => {
    const result = verifyMandateSignature({
      payloadSd: input.payloadSd,
      cm: BigInt(input.cm),
      assertion: input.assertion,
      passkey: {
        credentialID: input.assertion.credentialId,
        publicKey: input.publicKey,
        counter: 0,
      } as Passkey,
      expectedOrigin: input.origin,
      expectedRpId: input.rpId,
      spc: spcDetails(decodeMandate(input.payloadSd, input.disclosures) as Mandate),
    });
    if (expected === "ok") await expect(result).resolves.toBeDefined();
    else await expect(result).rejects.toThrow(messages[expected]);
  },
);
