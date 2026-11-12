import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { getDocument } from "pdfjs-dist";
import PDFDocument from "pdfkit";
import { toBytes } from "pdfkit/output";
import { describe, expect, test } from "vitest";
import { encodeAlibi, encodeAny, statementOf } from "../src/codec.ts";
import { extractAlibi } from "../src/extract.ts";
import { renderAlibiPdf } from "../src/pdf.ts";
import { verifyUrl } from "../src/qr.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { fixtures } from "./fixtures.ts";
import { cardV2Bundle, v2Bundle } from "./v2.ts";

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
  const task = getDocument({ data: pdf.slice() });
  try {
    const page = await (await task.promise).getPage(1);
    return (await page.getTextContent()).items.map((i) => ("str" in i ? i.str : "")).join(" ");
  } finally {
    await task.destroy();
  }
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

  // Two full offline verifications, each checking the C1 proof with bb.js.
  test("the embedded bundle verifies offline", { timeout: 30_000 }, async () => {
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

  test("its text reads back as written, without ligatures", async () => {
    const text = await textOf(await renderAlibiPdf(f.bundle));
    expect(text).toContain("keelson.finance");
    expect(text).not.toMatch(/[\uFB00-\uFB06]/);
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

describe("the pdf of a v2 Alibi", () => {
  const b = v2Bundle();
  test("embeds the bundle and its transparent statement, and names the envelope", async () => {
    const pdf = await renderAlibiPdf(b);
    expect(await renderAlibiPdf(b)).toEqual(pdf);
    expect(await extractAlibi(pdf)).toEqual(encodeAny(b));
    const task = getDocument({ data: pdf.slice() });
    try {
      const doc = await task.promise;
      const files = [...((await doc.getAttachments()) ?? new Map()).entries()] as [
        string,
        { filename: string },
      ][];
      const cose = files.find(([, a]) => a.filename === `${b.alibi_id}.cose`);
      expect(cose).toBeDefined();
      expect(await doc.getAttachmentContent(cose?.[0] as string)).toEqual(statementOf(b));
    } finally {
      await task.destroy();
    }
    expect(await textOf(pdf)).toContain("IETF SCITT transparent statement (RFC 9943)");
    expect(inflated(pdf)).toContain("/AFRelationship /Data");
    if (out) writeFileSync(join(out, `${b.alibi_id}-v2.pdf`), pdf);
  });

  test("a statement that is not the bundle's is refused", async () => {
    const doc = new PDFDocument();
    const pdf = toBytes(doc);
    doc.file(Buffer.from(encodeAny(b)), { name: `${b.alibi_id}.alibi` });
    doc.file(Buffer.from(statementOf(cardV2Bundle())), { name: `${b.alibi_id}.cose` });
    doc.text("Alibi");
    doc.end();
    await expect(extractAlibi(await pdf)).rejects.toMatchObject({ code: "attachment" });
  });
});
