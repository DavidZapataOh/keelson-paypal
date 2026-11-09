import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { getDocument } from "pdfjs-dist";
import { describe, expect, test } from "vitest";
import { encodeAlibi } from "../src/codec.ts";
import { extractAlibi } from "../src/extract.ts";
import { renderAlibiPdf } from "../src/pdf.ts";
import { verifyUrl } from "../src/qr.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { fixtures } from "./fixtures.ts";

const has = (tool: string) => {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
/** The CI job that validates the PDFs installs poppler and zbar and requires them. */
const qrTools = process.env.ALIBI_PDF_OUT !== undefined || (has("pdftoppm") && has("zbarimg"));
const out = process.env.ALIBI_PDF_OUT;
if (out) mkdirSync(out, { recursive: true });

/** The PII values of the sandbox buyer, which no Alibi may carry. */
const pii = [
  process.env.PAYPAL_SANDBOX_BUYER_EMAIL,
  process.env.PAYPAL_SANDBOX_BUYER_NAME,
  process.env.PAYPAL_SANDBOX_BUYER_ADDRESS,
].filter((v): v is string => typeof v === "string" && v.length > 3);

/** The PDF's bytes with every Flate stream inflated. */
function inflated(pdf: Uint8Array): string {
  const s = Buffer.from(pdf).toString("latin1");
  let all = s;
  for (const m of s.matchAll(/stream\r?\n/g)) {
    const start = (m.index as number) + m[0].length;
    const end = s.indexOf("endstream", start);
    try {
      all += inflateSync(Buffer.from(s.slice(start, end), "latin1")).toString("utf8");
    } catch {}
  }
  return all;
}

async function textOf(pdf: Uint8Array): Promise<string> {
  const doc = await getDocument({ data: pdf.slice() }).promise;
  const page = await doc.getPage(1);
  const text = (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
  await doc.destroy();
  return text;
}

describe.each(fixtures.map((f) => [f.id, f] as const))("the pdf of %s", (_, f) => {
  test("embeds the bundle byte for byte, renders the same twice and stays small", async () => {
    const pdf = await renderAlibiPdf(f.bundle);
    expect(await renderAlibiPdf(f.bundle)).toEqual(pdf);
    expect(pdf.length).toBeLessThanOrEqual(512 * 1024);
    const embedded = await extractAlibi(pdf);
    expect(embedded).toEqual(encodeAlibi(f.bundle));
    expect(embedded).toEqual(f.bytes);
    if (out) writeFileSync(join(out, `${f.id}.pdf`), pdf);
  });

  test("the embedded bundle verifies offline", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("no network");
    };
    try {
      const pdf = await renderAlibiPdf(f.bundle);
      const report = await verifyAlibi(f.bundle);
      const { decodeAlibi } = await import("../src/codec.ts");
      const again = await verifyAlibi(decodeAlibi(await extractAlibi(pdf)));
      expect(again.checks.filter((c) => c.status === "fail")).toEqual([]);
      expect(again.verdict).toBe(report.verdict);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("states the mode and carries no buyer PII", async () => {
    const pdf = await renderAlibiPdf(f.bundle);
    const text = await textOf(pdf);
    expect(text.includes("Degraded: TDX leg only")).toBe(f.mode === "degraded");
    const raw = inflated(pdf);
    for (const v of pii) {
      expect(raw.includes(v)).toBe(false);
      expect(text.includes(v)).toBe(false);
    }
  });

  test.skipIf(!qrTools)("its QR decodes to the verify url", async () => {
    const dir = mkdtempSync(join(tmpdir(), "alibi-qr-"));
    const file = join(dir, "a.pdf");
    writeFileSync(file, await renderAlibiPdf(f.bundle));
    execFileSync("pdftoppm", ["-r", "150", "-png", "-f", "1", "-l", "1", file, join(dir, "p")]);
    const png = execFileSync("ls", [dir])
      .toString()
      .split("\n")
      .find((n) => n.endsWith(".png"));
    const decoded = execFileSync("zbarimg", ["--raw", "-q", join(dir, png as string)])
      .toString()
      .trim();
    expect(decoded).toBe(verifyUrl(f.bundle));
    expect(readFileSync(file).length).toBeGreaterThan(0);
  });
});
