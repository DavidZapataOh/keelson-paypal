import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { base64url } from "jose";
import PDFDocument from "pdfkit";
import { toBytes } from "pdfkit/output";
import type { EvidencePack } from "./visa.ts";

const fonts = new URL(
  "../fonts/",
  `file://${createRequire(import.meta.url).resolve("@keelson/alibi/pdf")}`,
);
const font = (name: string) => readFileSync(new URL(`${name}.ttf`, fonts));
const SANS = font("Geist-Regular");
const SEMIBOLD = font("Geist-SemiBold");

const MM = 72 / 25.4;
const MARGIN = 20 * MM;
const INK = "#111111";
const MUTED = "#5b5b5b";
const STATUS = {
  evidenced: "Evidenced",
  not_evidenced: "Not evidenced",
  withheld: "Withheld from this copy",
  not_available: "Not available",
} as const;

interface Glyphs {
  hasGlyphForCodePoint(codePoint: number): boolean;
}

/**
 * Renders an evidence pack as a PDF/A-3b a card issuer can read, with the pack JSON, the
 * purchase's SCITT statement (`.cose`) and its Alibi attached. The same pack renders the same bytes.
 */
export async function renderEvidencePackPdf(
  p: EvidencePack,
  alibi: Uint8Array,
): Promise<Uint8Array> {
  const at = new Date(p.generated_at);
  const doc = new PDFDocument({
    subset: "PDF/A-3b",
    pdfVersion: "1.7",
    lang: "en-US",
    displayTitle: true,
    size: "A4",
    margin: MARGIN,
    font: SANS as unknown as string,
    info: {
      Title: `Agentic evidence pack ${p.transaction.alibi_id}`,
      Author: "Keelson",
      Subject: "Visa 4.1.23 and Compelling Evidence 3.0 evidence for one agent purchase",
      CreationDate: at,
      ModDate: at,
    },
  });
  const output = toBytes(doc);
  doc.registerFont("sans", SANS);
  doc.registerFont("semibold", SEMIBOLD);
  const attach = (bytes: Uint8Array, name: string, type: string, description: string) =>
    doc.file(Buffer.from(bytes), {
      name,
      type,
      description,
      relationship: "Source",
      creationDate: at,
      modifiedDate: at,
    });
  const { attestation: _, ...unsigned } = p;
  attach(
    new TextEncoder().encode(JSON.stringify(p)),
    "keelson-evidence-pack.json",
    "application/json",
    `Evidence pack, ${unsigned.type}`,
  );
  attach(
    base64url.decode(p.alibi.statement),
    `${p.transaction.alibi_id}.cose`,
    "application/scitt-statement+cose",
    "SCITT transparent statement",
  );
  attach(alibi, `${p.transaction.alibi_id}.alibi`, "application/json", "Keelson Alibi");

  // PDF/A forbids drawing a glyph the embedded font lacks.
  const printable = (text: string) => {
    const f = (doc as unknown as { _font: { font: Glyphs } })._font.font;
    return [...text]
      .map((ch) => (ch === "\n" || f.hasGlyphForCodePoint(ch.codePointAt(0) ?? 0) ? ch : "?"))
      .join("");
  };
  const t = p.transaction;
  doc.font("semibold").fontSize(22).fillColor(INK).text("Agentic evidence pack").moveDown(0.2);
  doc.font("sans").fontSize(9).fillColor(MUTED).text(printable(p.rules)).moveDown(0.8);
  doc.font("sans").fontSize(11).fillColor(INK);
  doc.text(
    printable(
      `Purchase ${t.alibi_id} at ${t.merchant.name}: ${t.amount_minor} minor units ${t.currency}, ${t.decision === "allow" ? "countersigned" : "refused"} ${t.countersigned_at}.`,
    ),
  );
  doc
    .text(
      printable(
        `Kept available until ${p.retained_until}. Transparency: ${p.transparency.standards}, ${p.transparency.statement_uri}`,
      ),
    )
    .moveDown(0.8);
  const section = (title: string, items: EvidencePack["requirements"]) => {
    doc.font("semibold").fontSize(13).fillColor(INK).text(printable(title)).moveDown(0.3);
    for (const item of items) {
      doc
        .font("semibold")
        .fontSize(10)
        .fillColor(INK)
        .text(printable(`${item.rule}  ${item.title}`));
      doc
        .font("sans")
        .fontSize(9)
        .fillColor(MUTED)
        .text(printable(`${STATUS[item.status]}. ${item.statement}`))
        .moveDown(0.4);
    }
    doc.moveDown(0.4);
  };
  section("Visa Core Rules 4.1.23", p.requirements);
  section("Compelling Evidence 3.0, Dispute Condition 10.4", p.ce3.elements);
  doc
    .font("sans")
    .fontSize(8)
    .fillColor(MUTED)
    .text("The attached files verify offline at verify.keelson.finance.");
  doc.end();
  return output;
}
