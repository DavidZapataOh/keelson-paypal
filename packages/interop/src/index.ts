/**
 * Exports of Keelson Alibis to the agentic-commerce standards (AP2 v0.2, Mastercard Verifiable
 * Intent v0.1, UCP 2026-08-25, ACP 2026-04-17, Visa TAP / Web Bot Auth, and the Visa §4.1.23 /
 * Compelling Evidence 3.0 evidence pack), and their offline verification.
 *
 * @packageDocumentation
 */

export { type AcpExport, exportAcp, verifyAcp } from "./acp.ts";
export {
  type Ap2Export,
  closeAp2,
  exportAp2,
  verifyAp2,
  verifyAp2Chain,
  verifyAp2Receipt,
} from "./ap2.ts";
export { BindingError, checkBinding, EXPORT_BINDINGS } from "./bindings.ts";
export { CONFORMANCE, type ExportKeys, exportAll, exportOne, FORMATS } from "./export.ts";
export { type PurchaseFacts, purchaseFacts, type StatementFacts, statementFacts } from "./facts.ts";
export {
  type AgentSigner,
  type EcPublicJwk,
  ExportRefused,
  type ExportSigner,
  jwks,
  teeExportSigner,
} from "./signer.ts";
export { type AlibiRef, refOf, StatementError, verifyStatement } from "./statement.ts";
export {
  AgentSignatureError,
  type Ed25519Signer,
  ed25519Signer,
  exportTap,
  NonceCache,
  signAgentRequest,
  type TapExport,
  verifyAgentRequest,
  verifyTap,
} from "./tap.ts";
export { EXPORT_ISSUER_KEYS } from "./trust.ts";
export {
  exportUcp,
  MerchantAuthorizationError,
  signMerchantAuthorization,
  type UcpExport,
  verifyMerchantAuthorization,
  verifyUcp,
} from "./ucp.ts";
export { type CheckId, type ExportReport, type Format, verifyExport } from "./verify.ts";
export { closeVi, exportVi, type ViExport, verifyVi } from "./vi.ts";
export { type EvidencePack, evidencePack, PACK_TYPE, verifyEvidencePack } from "./visa.ts";
