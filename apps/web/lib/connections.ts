/** Who stands behind an app, as the API proved it. */
export type ClientIdentity =
  | { kind: "cimd"; host: string; clientUri: string | null }
  | { kind: "operator"; agentId: string; operator: string; registry: string }
  | { kind: "hosted" }
  | { kind: "unverified" };

/** An agent's request for a mandate, as the approval page reads it. */
export interface ConnectionView {
  code: string;
  kind: "connect" | "once" | "change";
  state: "PENDING" | "APPROVED" | "DENIED" | "EXPIRED";
  name: string;
  reason: string;
  agent: {
    agentId: string;
    operator: string;
    bond: { asset: string; min: number; vault: string } | null;
  };
  /** Who stands behind the app that asked. */
  identity?: ClientIdentity;
  limits: {
    currency: string;
    perPurchaseMinor: string;
    totalMinor: string;
    askAboveMinor: string | null;
    merchants: { id: string; name: string }[];
    until: string;
  };
  /** The mandate a `once` cart is outside of, or a `change` replaces. */
  parent: {
    mandateId: string;
    perPurchaseMinor: string;
    totalMinor: string;
    remainingMinor: string;
    until: string;
  } | null;
  mandateId: string | null;
  /** For `once`: the cart the agent tried, as it saw it. */
  cart: {
    merchant: { id: string; name: string };
    currency: string;
    totalMinor: string;
    lines: {
      sku: string;
      size: string | null;
      color: string | null;
      category: string;
      qty: number;
      unitMinor: string;
    }[];
  } | null;
  /** For `once`: each mandate field against the cart; the failing ones are why it paused. */
  checks: { field: string; mandate: string | null; cart: string | null; pass: boolean }[] | null;
  /** The three numbers to pick the agent's from, until the user did; null when none is needed. */
  match: { options: number[]; matched: boolean } | null;
  expiresAt: string;
  createdAt: string;
}

export interface AgentRow {
  agentId: string;
  /** The app acting through Keelson's own agent, which many apps share; null for an agent's own operator. */
  clientId: string | null;
  name: string;
  operator: string;
  connected: boolean;
  mandate: {
    id: string;
    state: string;
    currency: string;
    maxMinor: string;
    remainingMinor: string;
    expiresAt: string;
    merchants: string[];
  } | null;
  lastActivityAt: string;
}

/** A cart an agent tried that its mandate does not allow, paused for the user. */
export interface PendingApproval {
  code: string;
  name: string;
  currency: string;
  amountMinor: string;
  overMinor: string | null;
  merchant: string;
  mandateId: string;
  expiresAt: string;
}

/** The prompt a user pastes into their agent to connect it to Keelson. */
export const CONNECT_PROMPT = `Connect to Keelson so you can buy for me within limits I approve.
Use Keelson's MCP server at https://api.keelson.finance/mcp, signed in as me, then call keelson.request_mandate with your name, why you need to buy, and the limits you need.
Show me the link it returns, and its two-digit number if it has one, then poll keelson.get_request as its answer says. Do not buy anything before I approve, and do not ask again if I decline.`;

/** "in 14 min", "in 2 h", "in 3 days" until `iso`. */
export function untilIn(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((Date.parse(iso) - now) / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 2 * 86_400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86_400)} days`;
}
