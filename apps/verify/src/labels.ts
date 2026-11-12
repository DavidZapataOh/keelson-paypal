import type { Check, CheckId, CheckStatus } from "@keelson/alibi/verify";

export const STEPS: Record<number, string> = {
  0: "Format and bindings",
  1: "Mandate",
  2: "Passkey and credentials",
  3: "TEE attestations",
  4: "Countersignature",
  5: "Policy replay",
  6: "Transparency log",
  7: "On-chain anchor",
  8: "Timestamps and proofs",
};

export const CHECKS: Record<CheckId, { label: string; who: string }> = {
  "bundle.format": { label: "Bundle format", who: "Keelson" },
  "leaf.view": { label: "Log leaf matches the bundle", who: "Keelson" },
  "qr.leaf": { label: "Matches the QR link", who: "Keelson" },
  "evidence.manifest": { label: "Evidence manifest", who: "Agent operator" },
  "evidence.web_fact": { label: "Store's product endpoint, notarized (TLSNotary)", who: "Keelson" },
  "evidence.checkout": { label: "Checkout total and its breakdown", who: "Agent operator" },
  "evidence.conversion": {
    label: "Currency conversion within the mandate's spread",
    who: "Agent operator",
  },
  "paypal.ids": { label: "PayPal ids", who: "Keelson" },
  "card.authorizations": { label: "Card charges approved by both TEEs", who: "Keelson" },
  "mandate.challenge": { label: "Mandate challenge", who: "User" },
  "mandate.passkey": { label: "User's passkey signature", who: "User" },
  "mandate.credentials": { label: "Mandate credentials", who: "Keelson" },
  "tee.attestation.tdx": { label: "Intel TDX attestation", who: "Keelson" },
  "tee.attestation.nitro": { label: "AWS Nitro attestation", who: "Keelson" },
  "tee.registry": { label: "Signers registered on-chain", who: "Keelson" },
  "tee.countersign": { label: "TEE countersignature", who: "Keelson" },
  "policy.replay": { label: "Policy decision replayed with Cedar", who: "Keelson" },
  "log.policy": { label: "Log policy is the pinned one", who: "Keelson" },
  "log.inclusion": { label: "Included in the log", who: "Keelson" },
  "log.witnesses": { label: "Witness cosignatures", who: "Witnesses" },
  "anchor.consistency": { label: "Anchor consistent with the log", who: "Keelson" },
  "scitt.statement": { label: "Signed statement (IETF SCITT)", who: "Keelson" },
  "scitt.receipt": { label: "Log receipt (COSE)", who: "Keelson" },
  "rats.cmw": { label: "TEE evidence package", who: "Keelson" },
  "card.statements": { label: "Card decisions and settlement, each logged", who: "Keelson" },
  "anchor.root": { label: "Root anchored on-chain", who: "Arbitrum" },
  "anchor.tx": { label: "Anchor transaction", who: "Arbitrum" },
  timestamps: { label: "RFC 3161 timestamps", who: "Timestamp authorities" },
  "zk.c1": { label: "Zero-knowledge proof", who: "Keelson" },
  "zk.c3": { label: "Signed by a registered user, anonymously", who: "Arbitrum" },
};

export const STATUS: Record<
  CheckStatus,
  { text: string; tone: "pass" | "fail" | "warn" | "mute" }
> = {
  pass: { text: "Verified", tone: "pass" },
  fail: { text: "Failed", tone: "fail" },
  undisclosed: { text: "Not disclosed to you", tone: "mute" },
  pending: { text: "Pending", tone: "warn" },
  absent: { text: "Not applicable", tone: "mute" },
  unreachable: { text: "Unreachable", tone: "warn" },
};

const EXPLORERS: Readonly<Record<string, string>> = {
  "421614": "https://sepolia.arbiscan.io",
  "42161": "https://arbiscan.io",
};

/** What a check found that can be checked outside the verifier: a note and an explorer link. */
export function evidenceOf(check: Check): {
  note?: string;
  link?: { href: string; label: string };
} {
  const d = check.detail;
  if (check.id !== "zk.c3" || !d?.root_tx) return {};
  const explorer = EXPLORERS[d.chain_id ?? ""];
  return {
    ...(check.status === "pass" && d.users
      ? {
          note: `One of ${Number(d.users).toLocaleString("en-US")} registered users; which one stays private.`,
        }
      : {}),
    ...(explorer
      ? {
          link: {
            href: `${explorer}/tx/${d.root_tx}`,
            label: `Root published in ${d.root_tx.slice(0, 10)}…${d.root_tx.slice(-4)}`,
          },
        }
      : {}),
  };
}
