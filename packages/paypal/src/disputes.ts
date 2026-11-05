import type { PayPalFetch } from "./rest.ts";
import {
  type Dispute,
  type DisputeSearch,
  dispute,
  disputeSearch,
  type SubsequentAction,
  subsequentAction,
} from "./schemas/disputes.ts";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;

export interface Evidence {
  evidence_type: string;
  notes?: string;
  evidence_info?: {
    tracking_info?: { carrier_name: string; tracking_number: string }[];
    refund_ids?: string[];
  };
  documents?: { name: string }[];
}

export interface EvidenceFile {
  name: string;
  bytes: Uint8Array;
}

const path = (id: string, action = "") =>
  `/v1/customer/disputes/${encodeURIComponent(id)}${action}`;

export async function listDisputes(
  f: PayPalFetch,
  q: { disputedTransactionId?: string; updateTimeAfter?: string } = {},
): Promise<DisputeSearch> {
  const query: Record<string, string> = {};
  if (q.disputedTransactionId) query.disputed_transaction_id = q.disputedTransactionId;
  if (q.updateTimeAfter) query.update_time_after = q.updateTimeAfter;
  return disputeSearch.parse(await f<unknown>("GET", "/v1/customer/disputes", { query }));
}

export async function getDispute(f: PayPalFetch, id: string): Promise<Dispute> {
  return dispute.parse(await f<unknown>("GET", path(id)));
}

/** The request body: an `input` JSON part plus one `file<n>` part per file (10 MB each, 50 MB total). */
export function evidenceForm(input: { evidences: Evidence[] }, files: EvidenceFile[]): FormData {
  let total = 0;
  for (const file of files) {
    if (file.bytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`${file.name} exceeds 10 MB`);
    total += file.bytes.byteLength;
  }
  if (total > MAX_TOTAL_BYTES) throw new RangeError("evidence files exceed 50 MB in total");

  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
  files.forEach((file, i) => {
    form.append(
      `file${i + 1}`,
      new Blob([new Uint8Array(file.bytes)], { type: mimeOf(file.name) }),
      file.name,
    );
  });
  return form;
}

export async function provideEvidence(
  f: PayPalFetch,
  id: string,
  input: { evidences: Evidence[] },
  files: EvidenceFile[],
): Promise<SubsequentAction> {
  return subsequentAction.parse(
    await f<unknown>("POST", path(id, "/provide-evidence"), { body: evidenceForm(input, files) }),
  );
}

function mimeOf(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "pdf") return "application/pdf";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  throw new TypeError(`unsupported evidence file type: ${name}`);
}

/** Moves an inquiry to a chargeback; PayPal then asks the seller for evidence. */
export async function escalate(
  f: PayPalFetch,
  id: string,
  note: string,
): Promise<SubsequentAction> {
  return subsequentAction.parse(
    await f<unknown>("POST", path(id, "/escalate"), { body: { note } }),
  );
}

function inputForm(input: unknown): FormData {
  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(input)], { type: "application/json" }));
  return form;
}

/** PayPal's OpenAPI spec accepts only `multipart/form-data`, with an optional `accept-claim-document` part. */
export async function acceptClaim(
  f: PayPalFetch,
  id: string,
  body: { note: string; accept_claim_reason?: string; invoice_id?: string },
  document?: EvidenceFile,
): Promise<SubsequentAction> {
  const form = inputForm(body);
  if (document) {
    form.append(
      "accept-claim-document",
      new Blob([new Uint8Array(document.bytes)], { type: mimeOf(document.name) }),
      document.name,
    );
  }
  return subsequentAction.parse(
    await f<unknown>("POST", path(id, "/accept-claim"), { body: form }),
  );
}

/** PayPal's OpenAPI spec accepts only `multipart/form-data`, with an optional `message_document` part. Inquiry stage only. */
export async function sendMessage(
  f: PayPalFetch,
  id: string,
  message: string,
  document?: EvidenceFile,
): Promise<SubsequentAction> {
  const form = inputForm({ message });
  if (document) {
    form.append(
      "message_document",
      new Blob([new Uint8Array(document.bytes)], { type: mimeOf(document.name) }),
      document.name,
    );
  }
  return subsequentAction.parse(
    await f<unknown>("POST", path(id, "/send-message"), { body: form }),
  );
}

function sandboxOnly(f: PayPalFetch, endpoint: string): void {
  if (f.env === "production") throw new Error(`${endpoint} is available in the sandbox only`);
}

export async function requireEvidence(
  f: PayPalFetch,
  id: string,
  action: "BUYER_EVIDENCE" | "SELLER_EVIDENCE",
): Promise<SubsequentAction> {
  sandboxOnly(f, "require-evidence");
  return subsequentAction.parse(
    await f<unknown>("POST", path(id, "/require-evidence"), { body: { action } }),
  );
}

export async function adjudicate(
  f: PayPalFetch,
  id: string,
  outcome: "BUYER_FAVOR" | "SELLER_FAVOR",
): Promise<SubsequentAction> {
  sandboxOnly(f, "adjudicate");
  return subsequentAction.parse(
    await f<unknown>("POST", path(id, "/adjudicate"), { body: { adjudication_outcome: outcome } }),
  );
}
