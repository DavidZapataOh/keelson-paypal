// Writes contracts/test/vectors/passkey-assertions.json from the real passkey assertions in
// @keelson/mandate's vectors: per case, the challenge the chain expects, the encoded assertion,
// the key and RP ID hash it is checked against, and whether `PasskeyAssertion.verify` accepts it.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hSd, mandateChallenge } from "@keelson/mandate";
import { p256 } from "@noble/curves/nist.js";
import { bytesToHex, type Hex } from "viem";
import { type Assertion, type SignedAssertion, toAssertion } from "../src/coverage.ts";

interface VerifyVector {
  name: string;
  input: {
    payloadSd: object;
    cm: string;
    rpId: string;
    publicKeySec1: string;
    assertion: SignedAssertion;
  };
}

const vectorsUrl = new URL("../../mandate/test/vectors/webauthn.json", import.meta.url);
const outUrl = new URL("../../../contracts/test/vectors/passkey-assertions.json", import.meta.url);
const N = p256.Point.CURVE().n;

const accepted = ["ok/webauthn.get", "ok/payment.get", "ok/high-s"];
const rejected = [
  "error/other-mandate",
  "error/rp-id",
  "error/user-not-verified",
  "error/user-not-present",
  "error/backup-state",
  "error/bad-signature",
  "error/type",
  "error/authenticator-data-short",
  "error/other-public-key",
];

/** The encoding of an assertion the encoder refuses, so the chain is shown to refuse it too. */
function rawAssertion(signed: SignedAssertion): Assertion {
  const json = Buffer.from(signed.clientDataJSON, "base64url");
  const { r, s } = p256.Signature.fromBytes(Buffer.from(signed.signature, "base64url"), "der");
  const word = (n: bigint): Hex => `0x${n.toString(16).padStart(64, "0")}`;
  return {
    r: word(r),
    s: word(s > N / 2n ? N - s : s),
    challengeIndex: BigInt(json.indexOf('"challenge":"')),
    typeIndex: BigInt(json.indexOf('"type":"')),
    authenticatorData: bytesToHex(Buffer.from(signed.authenticatorData, "base64url")),
    clientDataJSON: json.toString("utf8"),
  };
}

const all = JSON.parse(readFileSync(vectorsUrl, "utf8")) as VerifyVector[];
const byName = (name: string): VerifyVector => {
  const v = all.find((c) => c.name === `verify/${name}`);
  if (!v) throw new Error(`missing vector verify/${name}`);
  return v;
};

function chainCase(name: string, v: VerifyVector, assertion: Assertion, expected: boolean) {
  const { input } = v;
  return {
    name,
    challenge: bytesToHex(mandateChallenge(hSd(input.payloadSd), BigInt(input.cm))),
    hSd: bytesToHex(hSd(input.payloadSd)),
    cm: input.cm,
    assertion: {
      ...assertion,
      challengeIndex: Number(assertion.challengeIndex),
      typeIndex: Number(assertion.typeIndex),
    },
    qx: `0x${input.publicKeySec1.slice(4, 68)}`,
    qy: `0x${input.publicKeySec1.slice(68)}`,
    rpIdHash: `0x${createHash("sha256").update(input.rpId).digest("hex")}`,
    expected,
  };
}

const cases = [
  ...accepted.map((name) =>
    chainCase(name, byName(name), toAssertion(byName(name).input.assertion), true),
  ),
  ...rejected.map((name) => {
    const v = byName(name);
    return chainCase(name, v, rawAssertion(v.input.assertion), false);
  }),
];
const highS = toAssertion(byName("ok/high-s").input.assertion);
cases.push(
  chainCase(
    "error/high-s-unnormalized",
    byName("ok/high-s"),
    { ...highS, s: `0x${(N - BigInt(highS.s)).toString(16).padStart(64, "0")}` },
    false,
  ),
);

writeFileSync(outUrl, `${JSON.stringify({ cases }, null, 2)}\n`);
console.log(`wrote ${cases.length} cases to ${outUrl.pathname}`);
