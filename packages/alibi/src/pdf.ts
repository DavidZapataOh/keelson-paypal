import { readFileSync } from "node:fs";
import { CURRENCIES, type CurrencyCode, toHex } from "@keelson/core";
import PDFDocument from "pdfkit";
import { toBytes } from "pdfkit/output";
import QRCode from "qrcode";
import { encodeAlibi, leafHashOf } from "./codec.ts";
import { verifyUrl } from "./qr.ts";
import { ALIBI_MEDIA_TYPE, type AlibiBundle } from "./schema.ts";

const font = (name: string) => readFileSync(new URL(`../fonts/${name}.ttf`, import.meta.url));
const SANS = font("Geist-Regular");
const SEMIBOLD = font("Geist-SemiBold");
const MONO = font("GeistMono-Regular");

const MM = 72 / 25.4;
const MARGIN = 20 * MM;
/** The printed width of the QR, quiet zone included. */
const QR_WIDTH = 40 * MM;
const INK = "#111111";
const MUTED = "#5b5b5b";

const MODE = { "2of2": "2-of-2: TDX and Nitro", degraded: "Degraded: TDX leg only" } as const;

function amountOf(minor: string, currency: string): string {
  const info = CURRENCIES[currency as CurrencyCode];
  if (!info) return `${minor} (minor units) ${currency}`;
  const scale = 10n ** BigInt(info.exponent);
  const v = BigInt(minor);
  const frac = info.exponent > 0 ? `.${(v % scale).toString().padStart(info.exponent, "0")}` : "";
  return `${v / scale}${frac} ${currency}`;
}

/** The leaf's index and the size of the checkpoint the inclusion proof is against. */
function proofPosition(proof: string): { index: string; size: string } {
  const index = /\nindex (\d+)\n/.exec(proof)?.[1] ?? "?";
  const checkpoint = proof.slice(proof.indexOf("\n\n") + 2).split("\n");
  return { index, size: checkpoint[1] ?? "?" };
}

/**
 * Renders the Alibi as a one-page PDF/A-3b: a readable summary, a QR to its verify URL, and the
 * bundle itself embedded as `<alibi_id>.alibi` with `AFRelationship /Source`. Every byte is a
 * function of the bundle, so the same bundle renders the same file.
 */
export async function renderAlibiPdf(b: AlibiBundle): Promise<Uint8Array> {
  const issuedAt = new Date(String(b.leaf_view.issued_at));
  const doc = new PDFDocument({
    subset: "PDF/A-3b",
    pdfVersion: "1.7",
    lang: "en-US",
    displayTitle: true,
    size: "A4",
    margin: MARGIN,
    font: SANS as unknown as string,
    info: {
      Title: `Alibi ${b.alibi_id}`,
      Author: "Keelson",
      Subject: "Proof of an agent purchase: what was authorized, checked, countersigned and logged",
      CreationDate: issuedAt,
      ModDate: issuedAt,
    },
  });
  const output = toBytes(doc);
  doc.registerFont("sans", SANS);
  doc.registerFont("semibold", SEMIBOLD);
  doc.registerFont("mono", MONO);
  doc.file(Buffer.from(encodeAlibi(b)), {
    name: `${b.alibi_id}.alibi`,
    type: ALIBI_MEDIA_TYPE,
    description: "Keelson Alibi bundle",
    relationship: "Source",
    creationDate: issuedAt,
    modifiedDate: issuedAt,
  });

  const width = doc.page.width - 2 * MARGIN - QR_WIDTH - 8 * MM;
  const label = (text: string) =>
    doc
      .font("sans")
      .fontSize(8)
      .fillColor(MUTED)
      .text(text.toUpperCase(), { characterSpacing: 0.6 });
  const value = (text: string, mono = false) =>
    doc
      .font(mono ? "mono" : "sans")
      .fontSize(mono ? 8 : 11)
      .fillColor(INK)
      .text(text, { width })
      .moveDown(0.6);

  doc.font("semibold").fontSize(26).fillColor(INK).text("Alibi").moveDown(0.3);
  label("Alibi id");
  value(b.alibi_id, true);
  label("Leaf hash");
  value(toHex(leafHashOf(b)), true);
  label("Issued at (UTC)");
  value(issuedAt.toISOString().replace(".000Z", "Z"));

  const ctx = b.eval.context;
  label("Merchant");
  value(String(ctx.merchant));
  label("Amount");
  value(amountOf(b.tee.countersign.amount, String(ctx.currency)));
  label("Decision");
  value(b.eval.decision === "allow" ? "Allow" : "Deny");
  label("Countersigned by");
  value(MODE[b.tee.mode]);

  label("Policy checks");
  doc.moveDown(0.2);
  for (const f of b.eval.fields as {
    field?: string;
    id?: string;
    color?: string;
    pass?: boolean;
  }[]) {
    doc
      .font("sans")
      .fontSize(9.5)
      .fillColor(INK)
      .text(`${f.pass ? "Pass" : "Fail"}   ${f.field ?? f.id ?? ""}   (${f.color ?? ""})`, {
        width,
      });
  }
  doc.moveDown(0.8);

  const { index, size } = proofPosition(b.tlog_proof);
  label("Log");
  value(`${b.policy.origin}, leaf ${index}, checkpoint size ${size}`);
  label("On-chain anchor");
  value(
    b.anchor
      ? `Anchored at size ${b.anchor.anchored_size} on chain ${b.anchor.chain_id}, transaction ${b.anchor.tx_hash}`
      : "Not anchored yet",
  );
  label("PayPal");
  value(
    [
      `Order ${b.paypal.order_id}`,
      b.paypal.capture_id ? `Capture ${b.paypal.capture_id}` : "Not captured yet",
      b.paypal.invoice_id ? `Invoice ${b.paypal.invoice_id}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  const url = verifyUrl(b);
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const unit = QR_WIDTH / (n + 8);
  const x0 = doc.page.width - MARGIN - QR_WIDTH;
  const y0 = MARGIN;
  doc.rect(x0, y0, QR_WIDTH, QR_WIDTH).fill("#ffffff");
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) doc.rect(x0 + (c + 4) * unit, y0 + (r + 4) * unit, unit, unit);
    }
  }
  doc.fill("#000000");

  const footerY = doc.page.height - MARGIN - 40;
  doc
    .font("mono")
    .fontSize(6.5)
    .fillColor(INK)
    .text(url, MARGIN, footerY - 16, { width: doc.page.width - 2 * MARGIN });
  doc
    .font("sans")
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      `The machine-readable Alibi is embedded in this file as ${b.alibi_id}.alibi. Verify it at verify.keelson.finance.`,
      MARGIN,
      footerY,
      { width: doc.page.width - 2 * MARGIN },
    );

  doc.end();
  return output;
}

/** The QR's version and the printed size of one module, in millimetres. */
export function qrMetrics(b: AlibiBundle): { version: number; moduleMm: number } {
  const qr = QRCode.create(verifyUrl(b), { errorCorrectionLevel: "M" });
  return { version: qr.version, moduleMm: QR_WIDTH / (qr.modules.size + 8) / MM };
}
