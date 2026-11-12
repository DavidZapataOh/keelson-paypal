/** An export the receipt offers: the format's API path, who reads it, and what checks it. */
export interface ExportFormat {
  format: "ap2" | "vi" | "ucp" | "acp" | "tap" | "visa" | "visa.pdf";
  name: string;
  reader: string;
  checkedWith: string;
  file: string;
  group: "protocols" | "disputes";
}

/** The official tool behind each format, as Keelson's conformance checks name it. */
const TOOLS = {
  ap2: "Google's AP2 SDK and the AP2 conformance vectors",
  vi: "Mastercard Verifiable Intent verify_chain",
  ucp: "ucp-schema",
  acp: "ACP's JSON Schema",
  tap: "web-bot-auth and the RFC 9421 vectors",
  visa: "veraPDF and the published pack schema",
} as const;

export const EXPORTS: readonly ExportFormat[] = [
  {
    format: "ap2",
    name: "AP2 mandates and receipts",
    reader: "Agents and merchants on Google's Agent Payments Protocol",
    checkedWith: TOOLS.ap2,
    file: "ap2.json",
    group: "protocols",
  },
  {
    format: "vi",
    name: "Verifiable Intent",
    reader: "Card networks and issuers on Mastercard's intent chain",
    checkedWith: TOOLS.vi,
    file: "vi.json",
    group: "protocols",
  },
  {
    format: "ucp",
    name: "UCP checkout",
    reader: "Merchants on the Universal Commerce Protocol",
    checkedWith: TOOLS.ucp,
    file: "ucp.json",
    group: "protocols",
  },
  {
    format: "acp",
    name: "ACP allowance",
    reader: "Payment providers on the Agentic Commerce Protocol",
    checkedWith: TOOLS.acp,
    file: "acp.json",
    group: "protocols",
  },
  {
    format: "tap",
    name: "Signed agent request",
    reader: "Merchants and CDNs that check Visa TAP or Web Bot Auth. Expires in 8 minutes",
    checkedWith: TOOLS.tap,
    file: "tap.json",
    group: "protocols",
  },
  {
    format: "visa",
    name: "Visa evidence pack",
    reader: "Your card issuer, as data",
    checkedWith: TOOLS.visa,
    file: "visa-evidence.json",
    group: "disputes",
  },
  {
    format: "visa.pdf",
    name: "Visa evidence pack (PDF)",
    reader: "Your card issuer, for a chargeback",
    checkedWith: TOOLS.visa,
    file: "visa-evidence.pdf",
    group: "disputes",
  },
];

const REFUSALS: Record<string, string> = {
  denied: "Not available: this cart was refused, so nothing was paid.",
  no_cart: "Not available: this Alibi does not list its items, which this standard requires.",
  v1_alibi: "Not available yet for this Alibi. It stays verifiable as it is.",
  no_merchant_origin: "Not available: the store has no website to address the request to.",
  no_http_key: "Not available: the agent has no request-signing key.",
  no_agent_key: "Not available: only the agent that bought can close these mandates.",
  signer_unavailable: "Not available right now: the enclave that signs exports is not answering.",
};

/** The sentence a refusal reads as on the receipt. */
export const refusalOf = (reason: string): string =>
  REFUSALS[reason] ?? "This export is not available for this purchase.";
