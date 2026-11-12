import { exportAcp } from "./acp.ts";
import { exportAp2 } from "./ap2.ts";
import type { PurchaseFacts } from "./facts.ts";
import { type AgentSigner, ExportRefused, type ExportSigner } from "./signer.ts";
import type { AlibiRef } from "./statement.ts";
import { type Ed25519Signer, exportTap } from "./tap.ts";
import { exportUcp } from "./ucp.ts";
import type { Format } from "./verify.ts";
import { exportVi } from "./vi.ts";
import { evidencePack } from "./visa.ts";

export const FORMATS: readonly Format[] = ["ap2", "vi", "ucp", "acp", "tap", "visa"];

/** The official tool that checks each format, at the version Keelson's CI runs. */
export const CONFORMANCE: Record<Format, { tool: string; pin: string }> = {
  ap2: { tool: "Google's AP2 SDK and the AP2 conformance vectors", pin: "AP2 v0.2.0 @ e1ea56db" },
  vi: { tool: "Mastercard Verifiable Intent verify_chain", pin: "v0.1.0 @ 356c2963" },
  ucp: { tool: "ucp-schema", pin: "1.4.1, UCP 2026-08-25" },
  acp: { tool: "ACP's JSON Schema", pin: "2026-04-17" },
  tap: { tool: "web-bot-auth and the RFC 9421 vectors", pin: "web-bot-auth 0.2.0" },
  visa: { tool: "veraPDF and the published pack schema", pin: "PDF/A-3b" },
};

/** The signers an export needs: the enclave issuer, and the agent's keys when Keelson holds them. */
export interface ExportKeys {
  issuer: ExportSigner;
  agent?: AgentSigner;
  agentHttp?: Ed25519Signer;
  signatureAgent?: string;
}

/** One format's export of a purchase; throws `ExportRefused` when the format cannot state it. */
export async function exportOne(
  format: Format,
  f: PurchaseFacts,
  ref: AlibiRef,
  k: ExportKeys,
  o: { now: number; bundle: { cart?: unknown; mandate?: unknown }; shipping?: string },
): Promise<unknown> {
  // These formats name who is paid; an unknown payee is never stated as an empty one.
  if (!f.payee && (format === "ap2" || format === "vi" || format === "ucp" || format === "acp")) {
    throw new ExportRefused("no_payee");
  }
  switch (format) {
    case "ap2":
      return exportAp2(f, ref, k, o);
    case "vi":
      return exportVi(f, ref, k, o);
    case "ucp":
      if (!f.lines && !f.breakdown) throw new ExportRefused("no_cart");
      if (!k.agent) throw new ExportRefused("no_agent_key");
      return exportUcp(f, ref, { issuer: k.issuer, agent: k.agent }, o);
    case "acp":
      return exportAcp(f, ref, k, o);
    case "tap":
      return exportTap(f, ref, k, o);
    case "visa":
      return evidencePack(f, ref, k, o);
  }
}

/** Every format a purchase can be stated in; formats that refuse it are left out. */
export async function exportAll(
  f: PurchaseFacts,
  ref: AlibiRef,
  k: ExportKeys,
  o: { now: number; bundle: { cart?: unknown; mandate?: unknown }; shipping?: string },
): Promise<Partial<Record<Format, unknown>>> {
  const out: Partial<Record<Format, unknown>> = {};
  for (const format of FORMATS) {
    try {
      out[format] = await exportOne(format, f, ref, k, o);
    } catch (e) {
      if (!(e instanceof ExportRefused)) throw e;
    }
  }
  return out;
}
