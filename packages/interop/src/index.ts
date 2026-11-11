/**
 * Exports of Keelson mandates and Alibis to the agentic-commerce standards: AP2 v0.2, Mastercard
 * Verifiable Intent v0.1, UCP 2026-08-25, ACP 2026-04-17, Visa TAP / Web Bot Auth, and the Visa
 * §4.1.23 / CE3.0 Agentic Evidence Pack.
 *
 * @packageDocumentation
 */

export { ACP_MAX_TTL_SECONDS, type AcpAllowance, acpDelegation } from "./acp.ts";
export {
  type Ap2Closed,
  type Ap2Open,
  ap2Receipts,
  checkoutJwt,
  checkoutObject,
  closeAp2,
  closedPaymentPayload,
  instrumentOf,
  issueAp2Open,
  openPayload,
  type PaymentInstrument,
  receiptReference,
} from "./ap2.ts";
export {
  alibiMandate,
  type Line,
  type Merchant,
  type PurchaseFacts,
  purchaseFacts,
} from "./facts.ts";
export {
  disclosedPayload,
  type EcPublicJwk,
  hashB64u,
  jwtPayload,
  type Signer,
  signerFromJwk,
  signerOf,
} from "./jose.ts";
export { type Normalized, normalize } from "./normalize.ts";
export {
  ALIBI_HEADER,
  alibiHeader,
  ECDSA_P256,
  ecdsaSigner,
  ecdsaVerifier,
  signAgentRequest,
  TAP_TAGS,
  verifyAgentRequest,
} from "./tap.ts";
export {
  checkoutMandate,
  MerchantAuthorizationError,
  signMerchantAuthorization,
  UCP_VERSION,
  type UcpCheckout,
  ucpCheckout,
  verifyMerchantAuthorization,
} from "./ucp.ts";
export { closeVi, issueViL2, VI_L1_VCT, type ViChain, type ViL3 } from "./vi.ts";
export {
  type Ce3Element,
  type EvidencePack,
  evidencePack,
  PACK_TYPE,
  type PackItem,
  type PackStatus,
} from "./visa.ts";
