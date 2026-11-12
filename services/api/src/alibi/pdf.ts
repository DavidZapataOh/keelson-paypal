import type { AlibiBundle, AlibiBundleV2 } from "@keelson/alibi";
import { renderAlibiPdf } from "@keelson/alibi/pdf";
import { localPdfSigner, type PdfSigner, signAlibiPdf } from "@keelson/alibi/pdf-sign";
import type { Logger } from "pino";

let signer: Promise<PdfSigner | undefined> | undefined;

/** The PDF signer `KEELSON_PDF_SIGNING_KEY` and `KEELSON_PDF_SIGNING_CHAIN` name, if both are set. */
function pdfSigner(): Promise<PdfSigner | undefined> {
  const key = process.env.KEELSON_PDF_SIGNING_KEY;
  const chain = process.env.KEELSON_PDF_SIGNING_CHAIN;
  signer ??= key && chain ? localPdfSigner(key, chain) : Promise.resolve(undefined);
  return signer;
}

/**
 * The Alibi as a PDF, signed with PAdES B-T when a signing key is configured. A signature that
 * fails (the TSA is down) leaves the PDF unsigned rather than failing the caller: the Alibi inside
 * carries its own signatures and timestamp.
 */
export async function alibiPdf(
  log: Pick<Logger, "warn">,
  bundle: AlibiBundle | AlibiBundleV2,
): Promise<{ pdf: Uint8Array; signed: boolean }> {
  const pdf = await renderAlibiPdf(bundle);
  try {
    const s = await pdfSigner();
    if (!s) return { pdf, signed: false };
    return { pdf: await signAlibiPdf(pdf, s, { tsa: "digicert" }), signed: true };
  } catch (err) {
    log.warn({ err }, "alibi pdf not signed");
    return { pdf, signed: false };
  }
}
