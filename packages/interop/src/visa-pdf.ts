import { readFileSync } from "node:fs";
import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import PDFDocument from "pdfkit";
import { toBytes } from "pdfkit/output";
import type { EvidencePack, PackStatus } from "./visa.ts";

const fonts = new URL("../fonts/", import.meta.resolve("@keelson/alibi"));
const font = (name: string) => readFileSync(new URL(`${name}.ttf`, fonts));

const MM = 72 / 25.4;
const MARGIN = 18 * MM;
const INK = "#111111";
const MUTED = "#5b5b5b";
const RULE = "#d9d9d9";

const STATUS: Record<PackStatus, string> = {
  evidenced: "Evidenced",
  not_evidenced: "Not evidenced",
  withheld: "Withheld",
  informational: "Note",
};

function money(minor: number, currency: string): string {
  const exponent = CURRENCIES[currency as CurrencyCode]?.exponent ?? 2;
  return `${(minor / 10 ** exponent).toFixed(exponent)} ${currency}`;
}

/**
 * Renders the Agentic Evidence Pack as a PDF/A-3b with the pack's JSON embedded as
 * `<alibi_id>.evidence.json` (`AFRelationship /Source`), so the printed and the machine copy are
 * one file.
 */
export async function renderEvidencePackPdf(pack: EvidencePack): Promise<Uint8Array> {
  const generated = new Date(pack.generated_at);
  const doc = new PDFDocument({
    subset: "PDF/A-3b",
    pdfVersion: "1.7",
    lang: "en-US",
    displayTitle: true,
    size: "A4",
    margin: MARGIN,
    font: font("Geist-Regular") as unknown as string,
    info: {
      Title: `Agentic Evidence Pack ${pack.transaction.alibi_id}`,
      Author: "Keelson",
      Subject: "Visa §4.1.23 and Compelling Evidence 3.0 evidence for an agent purchase",
      CreationDate: generated,
      ModDate: generated,
    },
  });
  const output = toBytes(doc);
  doc.registerFont("sans", font("Geist-Regular"));
  doc.registerFont("semibold", font("Geist-SemiBold"));
  doc.registerFont("mono", font("GeistMono-Regular"));
  doc.file(Buffer.from(JSON.stringify(pack, null, 2)), {
    name: `${pack.transaction.alibi_id}.evidence.json`,
    type: "application/json",
    description: "Agentic Evidence Pack",
    relationship: "Source",
    creationDate: generated,
    modifiedDate: generated,
  });

  const width = doc.page.width - 2 * MARGIN;
  const heading = (text: string) => {
    doc.moveDown(0.8).font("semibold").fontSize(11).fillColor(INK).text(text);
    doc
      .moveTo(MARGIN, doc.y + 2)
      .lineTo(MARGIN + width, doc.y + 2)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc.moveDown(0.4);
  };
  const row = (label: string, value: string, mono = false) => {
    const y = doc.y;
    doc
      .font("sans")
      .fontSize(9)
      .fillColor(MUTED)
      .text(label, MARGIN, y, { width: 42 * MM });
    doc
      .font(mono ? "mono" : "sans")
      .fontSize(9)
      .fillColor(INK)
      .text(value, MARGIN + 44 * MM, y, { width: width - 44 * MM });
    doc.moveDown(0.25);
  };

  const t = pack.transaction;
  doc.font("semibold").fontSize(18).fillColor(INK).text("Agentic Evidence Pack");
  doc.font("sans").fontSize(9).fillColor(MUTED).text(pack.rules);

  heading("Transaction");
  row("Alibi", t.alibi_id, true);
  row("Decision", t.decision === "allow" ? "Countersigned (allow)" : "Refused (deny)");
  row("Countersigned at", t.countersigned_at);
  row("Amount", money(t.amount_minor, t.currency));
  row("Merchant", [t.merchant.name, t.merchant.website].filter(Boolean).join(" · "));
  if (t.paypal) {
    row("PayPal order", t.paypal.order_id, true);
    if (t.paypal.capture_id) row("PayPal capture", t.paypal.capture_id, true);
  }

  heading("§4.1.23 Agentic Platform Requirements");
  for (const r of pack.requirements) {
    const y = doc.y;
    doc
      .font("semibold")
      .fontSize(9)
      .fillColor(INK)
      .text(r.rule, MARGIN, y, { width: 18 * MM });
    doc.font("semibold").text(r.title, MARGIN + 20 * MM, y, { width: width - 52 * MM });
    doc
      .font("sans")
      .fillColor(r.status === "evidenced" ? INK : MUTED)
      .text(STATUS[r.status], MARGIN + width - 30 * MM, y, {
        width: 30 * MM,
        align: "right",
      });
    doc
      .font("sans")
      .fillColor(MUTED)
      .text(r.statement, MARGIN + 20 * MM, doc.y, { width: width - 20 * MM });
    doc.moveDown(0.45);
  }

  heading("Compelling Evidence 3.0 · Dispute Condition 10.4");
  for (const e of pack.ce3.elements) {
    row(
      e.element.replaceAll("_", " "),
      [e.value, e.status.replaceAll("_", " "), e.note].filter(Boolean).join(" · "),
    );
  }

  heading("Order confirmation (§4.1.23.8)");
  const o = pack.order_confirmation;
  row("Description", o.description || "—");
  row("Total", money(o.total_minor, o.currency));
  row("Returns", o.return_policy);
  if (o.merchant_contact) row("Merchant", o.merchant_contact);
  row("Retained at least until", o.retained_until);

  heading("Verify");
  doc
    .font("sans")
    .fontSize(9)
    .fillColor(INK)
    .text("Anyone can check every claim above against the Alibi:", { width });
  doc
    .font("mono")
    .fontSize(8)
    .fillColor(INK)
    .text(pack.verify_url, { width, link: pack.verify_url });
  doc.end();
  return output;
}
