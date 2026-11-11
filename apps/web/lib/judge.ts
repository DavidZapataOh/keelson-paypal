import type { Card } from "@keelson/mandate/browser";
import { get, post } from "./api";
import { API } from "./config";

export interface TourPurchase {
  id: string;
  state: string;
  mode: string | null;
  amount: { currency: string; minor: string };
  merchant_id: string;
  created_at: string;
  log_index: string | null;
  capture_id: string | null;
  coverage_tx: string | null;
  failure: string | null;
  checks: { field: string; color: string; pass: boolean }[];
  /** `<leaf hash>.<anchored size>.<chain id>`, the verifier link's fragment. */
  alibi_fragment: string | null;
}

export interface Tour {
  merchant_id: string;
  agent_id: string | null;
  mandate: {
    id: string;
    state: string;
    mandate_hash: string | null;
    budget: { currency: string; max_minor: string };
    created_at: string;
    card: Card | null;
    purchases: TourPurchase[];
  } | null;
  /** The newest test purchase with a composed anonymous proof. */
  anonymous_purchase: { id: string; alibi_fragment: string | null } | null;
  dispute_id: string | null;
  campaign_id: string | null;
}

/** `GET /v1/disputes/{id}`: public. */
export interface DisputeStatus {
  dispute_id: string;
  purchase_id: string;
  state: "OPEN" | "ATTRIBUTED" | "RESOLVED";
  reason: string;
  received_at: string | null;
  attributed_at: string | null;
  elapsed_ms: number | null;
  liable: "operator" | "keelson" | "merchant" | "user" | null;
  verdict: {
    rule: string;
    digest: string;
    chain_id: number;
    signatures: { tee: number; signer: string }[];
  } | null;
  settlement: {
    rail: "pyusd" | "paypal";
    outcome: "paid" | "queued" | "claimable" | "failed" | null;
    paid_by: "chain" | "treasury" | "violation-pool" | null;
    refund_id: string | null;
    tx_hash: string | null;
    explorer_url: string | null;
    payout_batch_id: string | null;
    settled_at: string | null;
  } | null;
}

/** `GET /v1/operators/{agentId}/grade`: public. */
export interface Grade {
  agentId: string;
  grade: "A" | "B" | "C" | "D" | "F";
  computedAt: string;
  evidence: { coverages: number; incidents: { total: number } };
  reserve: { warranties: number };
  frequency: { mean_ppm: number; upper95_ppm: number };
  premium: { bps: number };
  bond: { requiredMinor: number };
}

/** Opens a judge: an anonymous tenant signed in with a session cookie. */
export const startJudge = (invite?: string) =>
  post<{ user_id: string }>("/v1/judge/sessions", invite ? { invite } : undefined);
export const tour = () => get<Tour>("/v1/judge/tour");
export const disputeOf = (id: string) => get<DisputeStatus>(`/v1/disputes/${id}`);
export const gradeOf = (agentId: string) => get<Grade>(`/v1/operators/${agentId}/grade`);

export type Health = "up" | "down" | "degraded";

/** `GET /status`: the API's dependency report. */
export interface StatusReport {
  status: "ok" | "degraded";
  dependencies: {
    db: Health;
    kv: Health;
    teeA: Health;
    teeB: Health;
    log: {
      status: Health;
      origins: { origin: string; size: number; checkpointAgeMs: number | null }[];
    };
    relayer: {
      status: Health;
      chains: { chainId: number; status: Health; balanceWei: string; pending: number }[];
    };
    paypal: { status: Health; environment: "sandbox" | "production" };
    webhooks: { status: Health; lastWebhookAgeMs: number | null; lastPollAgeMs: number | null };
    anchor: { status: Health; environment: string; size: string; anchoredAgeMs: number | null };
  };
}

export async function statusReport(): Promise<StatusReport> {
  const res = await fetch(`${API}/status`, { cache: "no-store" });
  // The report is the body of a 503 too: a dependency being down is still an answer.
  return (await res.json()) as StatusReport;
}

export type Environment = "Sandbox" | "Testnet" | "Production";

/** Where each dependency of the deployment runs. The same table is in the README. */
export const ENVIRONMENTS: { dependency: string; env: Environment; what: string }[] = [
  {
    dependency: "PayPal",
    env: "Sandbox",
    what: "Orders, holds, captures, refunds, payouts and disputes. No real money moves.",
  },
  {
    dependency: "Arbitrum Sepolia",
    env: "Testnet",
    what: "Bond vault, reserve, verdict verifier and the log's checkpoint anchor. Test PYUSD.",
  },
  {
    dependency: "TEE leg A · Intel TDX on Phala Cloud",
    env: "Production",
    what: "Real attested hardware. Issues mandates, reads PayPal, countersigns.",
  },
  {
    dependency: "TEE leg B · AWS Nitro Enclaves",
    env: "Production",
    what: "Real attested hardware. Re-evaluates every cart; both signatures are required.",
  },
  {
    dependency: "Alibi log and witnesses",
    env: "Production",
    what: "Public append-only Merkle log, checkpoints co-signed by independent witnesses.",
  },
  {
    dependency: "Claude (Anthropic API)",
    env: "Production",
    what: "Compiles mandates, drives the shopping agent and the red team, drafts dispute answers.",
  },
  {
    dependency: "Agent browser (Kernel)",
    env: "Production",
    what: "The shopping agent's cloud browser, with a read-only live view.",
  },
  {
    dependency: "Demo store",
    env: "Sandbox",
    what: "RunFast, a store we run so attacks can be planted; it checks out with PayPal sandbox.",
  },
];
