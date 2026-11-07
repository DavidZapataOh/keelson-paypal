import { X509Certificate } from "node:crypto";
import { Decoder, Encoder } from "cbor-x";
import { describe, expect, test } from "vitest";
import { AttestError } from "../src/errors.ts";
import { isDebugMode, verifyNitro } from "../src/nitro.ts";
import { AWS_NITRO_ROOT_PEM } from "../src/roots/aws-nitro-root-g1.ts";
import { nitroEvidence } from "./evidence.ts";

const document = Buffer.from(nitroEvidence.attestation.document, "base64");
const now = new Date(nitroEvidence.capturedAt);
const maps = new Decoder({ mapsAsObjects: false });
const encoder = new Encoder({ mapsAsObjects: false, useRecords: false });

/** Re-encodes the document with its payload changed and the original signature. */
function remake(change: (payload: Map<string, unknown>) => void): Uint8Array {
  const decoded = maps.decode(document);
  const sign1 = (decoded.value ?? decoded) as [Uint8Array, unknown, Uint8Array, Uint8Array];
  const payload = maps.decode(sign1[2]) as Map<string, unknown>;
  change(payload);
  const out = [sign1[0], new Map(), encoder.encode(payload), sign1[3]];
  return encoder.encode(decoded.tag === 18 ? { tag: 18, value: out } : out);
}

const fail = async (p: Promise<unknown>) => {
  const error = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AttestError);
  return (error as AttestError).code;
};

describe("verifyNitro", () => {
  test("verifies the captured document and returns what it attests", async () => {
    const result = await verifyNitro(document, { now });
    expect(result.digest).toBe("SHA384");
    expect(result.pcrs[0]).toMatch(/^0x[0-9a-f]{96}$/);
    expect(result.publicKey).toMatch(/^0x04[0-9a-f]{128}$/);
    expect(result.userData).toMatch(/^0x[0-9a-f]{128}$/);
    expect(result.nonce).toBe(nitroEvidence.attestation.block.hash);
    expect(result.timestamp).toBeLessThanOrEqual(now.getTime());
  });

  test("bundles the root AWS publishes", () => {
    const fingerprint = new X509Certificate(AWS_NITRO_ROOT_PEM).fingerprint256;
    const published =
      "64:1A:03:21:A3:E2:44:EF:E4:56:46:31:95:D6:06:31:7E:D7:CD:CC:3C:17:56:E0:98:93:F3:C6:8F:79:BB:5B";
    expect(fingerprint).toBe(published);
  });

  test("rejects a payload that changed after signing", async () => {
    const changed = remake((p) => {
      const nonce = Buffer.from(p.get("nonce") as Uint8Array);
      nonce[0] = (nonce[0] ?? 0) ^ 1;
      p.set("nonce", nonce);
    });
    expect(await fail(verifyNitro(changed, { now }))).toBe("signature");
  });

  test("rejects a flipped signature byte", async () => {
    const changed = Buffer.from(document);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(await fail(verifyNitro(changed, { now }))).toBe("signature");
  });

  test("rejects a reversed cabundle", async () => {
    const changed = remake((p) =>
      p.set("cabundle", [...(p.get("cabundle") as unknown[])].reverse()),
    );
    expect(await fail(verifyNitro(changed, { now }))).toBe("cert_chain");
  });

  test("rejects a cabundle without an intermediate", async () => {
    const changed = remake((p) => p.set("cabundle", (p.get("cabundle") as unknown[]).slice(0, -1)));
    expect(await fail(verifyNitro(changed, { now }))).toBe("cert_chain");
  });

  test("rejects a cabundle that is not rooted at the AWS root", async () => {
    const changed = remake((p) => {
      const bundle = [...(p.get("cabundle") as Uint8Array[])];
      bundle.shift();
      p.set("cabundle", bundle);
    });
    expect(await fail(verifyNitro(changed, { now }))).toBe("cert_chain");
  });

  test("rejects a document after its leaf certificate expired", async () => {
    const later = new Date(now.getTime() + 24 * 3600 * 1000);
    expect(await fail(verifyNitro(document, { now: later }))).toBe("cert_chain");
  });

  test("rejects a document that is not a COSE_Sign1", async () => {
    expect(await fail(verifyNitro(new Uint8Array([1, 2, 3]), { now }))).toBe("cose");
  });
});

describe("isDebugMode", () => {
  test("flags an all-zero PCR0 and passes the captured one", async () => {
    const result = await verifyNitro(document, { now });
    expect(isDebugMode(result.pcrs)).toBe(false);
    expect(isDebugMode({ ...result.pcrs, 0: `0x${"00".repeat(48)}` })).toBe(true);
  });
});
