/** The formats Keelson exports to. */
export type Format = "ap2" | "vi" | "ucp" | "acp" | "tap" | "visa";

/** One check of an export's verification. */
export type CheckId =
  | "schema"
  | "signatures"
  | "issuer"
  | "statement"
  | "receipt"
  | "facts"
  | "chain_binding"
  | "nonce"
  | "receipt_reference"
  | "bundle"
  | "passkey"
  | "window"
  | "tag"
  | "replay";

/** What verifying an export found. */
export interface ExportReport {
  format: Format;
  ok: boolean;
  checks: { id: CheckId; ok: boolean; detail?: string }[];
  ms: number;
}
