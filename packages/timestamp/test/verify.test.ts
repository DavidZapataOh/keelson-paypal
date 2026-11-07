import { readFileSync } from "node:fs";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, test } from "vitest";
import { TimestampError, type TsaId, verifyTimestamp } from "../src/index.ts";
import { pemToDer } from "../src/pem.ts";
import { TSA_ROOTS } from "../src/roots/index.ts";
import { SIGSTORE_TSA_ROOT_PEM } from "../src/roots/sigstore-tsa.ts";
import { expected, imprint, tokens } from "./tokens.ts";

const TSAS: TsaId[] = ["digicert", "sigstore", "freetsa", "sectigo"];

async function code(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(TimestampError);
  return (error as TimestampError).code;
}

/** Flips one bit of `bytes` at offset `at` of the only occurrence of `part`. */
function flipIn(bytes: Uint8Array, part: Uint8Array, at: number): Uint8Array {
  const hex = Buffer.from(bytes).toString("hex");
  const needle = Buffer.from(part).toString("hex");
  const index = hex.indexOf(needle);
  expect(index % 2).toBe(0);
  expect(hex.indexOf(needle, index + 1)).toBe(-1);
  const copy = bytes.slice();
  copy[index / 2 + at] = (copy[index / 2 + at] as number) ^ 0x01;
  return copy;
}

function signerInfo(token: Uint8Array): pkijs.SignerInfo {
  const contentInfo = pkijs.ContentInfo.fromBER(token as Uint8Array<ArrayBuffer>);
  const info = new pkijs.SignedData({ schema: contentInfo.content }).signerInfos[0];
  if (!info) throw new Error("no signer");
  return info;
}

describe("captured tokens", () => {
  for (const tsa of TSAS) {
    test(`${tsa} verifies and is named by its root`, async () => {
      const result = await verifyTimestamp(tokens[tsa], imprint);
      expect(result.tsa).toBe(tsa);
      expect(result.genTime).toBe(expected[tsa].genTime);
      expect(result.serial).toBe(expected[tsa].serial);
      expect(result.signer.sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    test(`${tsa} verifies at genTime, not now`, async () => {
      const now = await verifyTimestamp(tokens[tsa], imprint);
      const later = await verifyTimestamp(tokens[tsa], imprint, { now: new Date("2040-01-01") });
      expect(later).toEqual(now);
    });
  }
});

describe("rejections", () => {
  test("another imprint", async () => {
    const other = imprint.slice();
    other[31] = (other[31] as number) ^ 0x01;
    expect(await code(verifyTimestamp(tokens.digicert, other))).toBe("tsa-imprint");
  });

  test("a token that is not DER", async () => {
    expect(await code(verifyTimestamp(tokens.digicert.subarray(0, 100), imprint))).toBe(
      "tsa-parse",
    );
  });

  for (const tsa of TSAS) {
    test(`${tsa} with one signature bit flipped`, async () => {
      const token = tokens[tsa].slice();
      const signature = signerInfo(token).signature.valueBlock.valueHexView;
      const tampered = flipIn(token, signature, signature.length - 8);
      expect(await code(verifyTimestamp(tampered, imprint))).toBe("tsa-signature");
    });
  }

  test("a DigiCert token checked against the Sigstore root only", async () => {
    const roots = { sigstore: [pemToDer(SIGSTORE_TSA_ROOT_PEM)] };
    expect(await code(verifyTimestamp(tokens.digicert, imprint, { roots }))).toBe("tsa-chain");
  });

  for (const tsa of ["digicert", "sigstore"] as const) {
    test(`${tsa} with its signingCertificateV2 hash altered`, async () => {
      const token = tokens[tsa].slice();
      const attribute = signerInfo(token).signedAttrs?.attributes.find(
        (a) => a.type === "1.2.840.113549.1.9.16.2.47",
      );
      if (!attribute) throw new Error("no signingCertificateV2");
      const certs = (attribute.values[0] as asn1js.Sequence).valueBlock.value[0];
      const essCertIdV2 = (certs as asn1js.Sequence).valueBlock.value[0];
      const certHash = (essCertIdV2 as asn1js.Sequence).valueBlock.value.find(
        (v) => v instanceof asn1js.OctetString,
      ) as asn1js.OctetString;
      const tampered = flipIn(token, certHash.valueBlock.valueHexView, 0);
      expect(["tsa-signature", "tsa-ess-cert"]).toContain(
        await code(verifyTimestamp(tampered, imprint)),
      );
    });
  }
});

describe("hostile tokens", () => {
  test("a certificate cycle (S <- A <- B <- A) fails fast as tsa-chain", async () => {
    const token = new Uint8Array(readFileSync(new URL("./forged/cycle.tst", import.meta.url)));
    const cycleImprint = Uint8Array.from(
      Buffer.from("2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881", "hex"),
    );
    const started = performance.now();
    expect(await code(verifyTimestamp(token, cycleImprint))).toBe("tsa-chain");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("a token is accepted only from the TSA the caller expects", async () => {
    const result = await verifyTimestamp(tokens.sigstore, imprint, { expectedTsa: "sigstore" });
    expect(result.tsa).toBe("sigstore");
    expect(await code(verifyTimestamp(tokens.sigstore, imprint, { expectedTsa: "digicert" }))).toBe(
      "tsa-chain",
    );
  });

  test("a signer outside the TSA's pinned issuing CA or key is refused", async () => {
    // The DigiCert root is pinned for Sectigo here: the chain would end at a pinned root, but
    // neither the issuing CA nor the signer is DigiCert's timestamping one.
    const roots = { digicert: [pemToDer(TSA_ROOTS.sectigo)] };
    expect(await code(verifyTimestamp(tokens.sectigo, imprint, { roots }))).toBe("tsa-chain");
  });
});
