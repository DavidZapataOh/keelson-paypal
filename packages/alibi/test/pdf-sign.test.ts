import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyTimestamp } from "@keelson/timestamp";
import type * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { describe, expect, test } from "vitest";
import { extractAlibi } from "../src/extract.ts";
import { renderAlibiPdf } from "../src/pdf.ts";
import { localPdfSigner, signAlibiPdf } from "../src/pdf-sign.ts";
import { fixtures } from "./fixtures.ts";

const has = (tool: string) => {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** A document-signing chain issued by its own P-256 root, as `scripts/pdf-cert.sh` makes it. */
function chain() {
  const dir = mkdtempSync(join(tmpdir(), "pdf-cert-"));
  execFileSync("sh", [new URL("../scripts/pdf-cert.sh", import.meta.url).pathname, dir], {
    stdio: "ignore",
  });
  return {
    key: readFileSync(join(dir, "signing-key.pem"), "utf8"),
    chain: readFileSync(join(dir, "signing-chain.pem"), "utf8"),
  };
}

/** The signed byte ranges and the CMS in `/Contents` of the last signature in `pdf`. */
function signatureOf(pdf: Uint8Array) {
  const text = Buffer.from(pdf).toString("latin1");
  const at = text.lastIndexOf("/ByteRange [");
  const [a, b, c, d] = (/\/ByteRange \[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/.exec(text.slice(at)) ?? [])
    .slice(1)
    .map(Number) as [number, number, number, number];
  const signedBytes = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  const hex = text.slice(a + b + 1, c - 1).replace(/(00)+$/, "");
  return { signedBytes, cms: new Uint8Array(Buffer.from(hex, "hex")) };
}

const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());

describe("the signed Alibi PDF (PAdES B-T)", () => {
  test("carries a CAdES signature over the whole rendered file and a timestamp of its value", async () => {
    const certs = chain();
    const signer = await localPdfSigner(certs.key, certs.chain);
    const fixture = fixtures[0] as (typeof fixtures)[number];
    const pdf = await renderAlibiPdf(fixture.bundle);
    const started = performance.now();
    const signed = await signAlibiPdf(pdf, signer, { tsa: "digicert" });
    const ms = performance.now() - started;

    // An incremental update: the rendered file is its prefix, so its attachment is the same.
    expect(Buffer.from(signed.subarray(0, pdf.length)).equals(Buffer.from(pdf))).toBe(true);
    expect(await extractAlibi(signed)).toEqual(await extractAlibi(pdf));
    const text = Buffer.from(signed).toString("latin1");
    expect(text).toContain("/SubFilter /ETSI.CAdES.detached");
    // PDF/A: the update's trailer names the same file identifier as the rendered file's.
    const ids = [...text.matchAll(/\/ID\s*\[<([0-9a-f]+)>/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);

    const { signedBytes, cms } = signatureOf(signed);
    const content = pkijs.ContentInfo.fromBER(cms);
    const sd = new pkijs.SignedData({ schema: content.content });
    expect(
      await sd.verify({ signer: 0, data: Uint8Array.from(signedBytes).buffer, checkChain: false }),
    ).toBe(true);
    const info = sd.signerInfos[0] as pkijs.SignerInfo;
    const types = info.signedAttrs?.attributes.map((x) => x.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "1.2.840.113549.1.9.3",
        "1.2.840.113549.1.9.4",
        "1.2.840.113549.1.9.16.2.47",
      ]),
    );
    // PAdES: no signing time among the signed attributes.
    expect(types).not.toContain("1.2.840.113549.1.9.5");
    const ts = info.unsignedAttrs?.attributes.find((x) => x.type === "1.2.840.113549.1.9.16.2.14");
    expect(ts).toBeDefined();
    const token = new Uint8Array(((ts as pkijs.Attribute).values[0] as asn1js.Sequence).toBER());
    const stamp = await verifyTimestamp(
      token,
      sha256(new Uint8Array(info.signature.valueBlock.valueHexView)),
    );
    expect(stamp.tsa).toBe("digicert");
    expect(Date.parse(stamp.genTime)).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(ms).toBeLessThan(5_000);

    const out = process.env.ALIBI_PDF_OUT;
    if (out) {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, `signed-${fixture.id}.pdf`), signed);
    }
    if (has("pdfsig")) {
      const dir = mkdtempSync(join(tmpdir(), "signed-"));
      const file = join(dir, "alibi.pdf");
      writeFileSync(file, signed);
      const report = execFileSync("pdfsig", ["-nocert", file], { encoding: "utf8" });
      expect(report).toContain("ETSI.CAdES.detached");
      expect(report).toContain("Signature is Valid.");
    }
  }, 30_000);
});
