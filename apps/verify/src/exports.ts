import type { EcPublicJwk, ExportReport } from "@keelson/interop";

const FORMATS: Record<string, { format: string; name: string }> = {
  "keelson.ap2/1": { format: "ap2", name: "AP2 mandates and receipts" },
  "keelson.vi/1": { format: "vi", name: "Mastercard Verifiable Intent" },
  "keelson.ucp/1": { format: "ucp", name: "UCP checkout" },
  "keelson.acp/1": { format: "acp", name: "ACP allowance" },
  "keelson.tap/1": { format: "tap", name: "Signed agent request (Visa TAP / Web Bot Auth)" },
  "keelson.visa-evidence-pack/1": { format: "visa", name: "Visa evidence pack" },
};

/** The standards export a dropped JSON file is, or `null` for anything else. */
export function exportOf(value: unknown): { format: string; name: string } | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" ? (FORMATS[type] ?? null) : null;
}

/** Verifies an export in the browser; the interop code loads only when an export is dropped. */
export async function checkExport(
  x: unknown,
  o: { now: number; issuerKeys?: EcPublicJwk[]; receiptKeys?: ReadonlyMap<string, Uint8Array> },
): Promise<ExportReport> {
  const { verifyExport } = await import("@keelson/interop");
  return verifyExport(x, o);
}
