/**
 * The Keelson mandate model: the `keelson.mandate.1` schema, its selective disclosure, the
 * commitment `C_m` and passkey challenge `M`, the user credential and open mandate, and the card
 * the user signs. The Rust engine's `keelson-mandate` crate mirrors every function that both sides
 * run, pinned by golden vectors.
 *
 * @packageDocumentation
 */

export {
  C3_MAX_CLIENT_DATA,
  type C3Assertion,
  type C3Inputs,
  type C3Statement,
  c3Inputs,
  USER_SET_DEPTH,
  type UserSet,
  userPath,
  userSet,
} from "./c3.ts";
export {
  type Answerer,
  CATEGORY_LABELS,
  type Card,
  type CardRow,
  MCC_LABELS,
  prepareSigning,
  renderCard,
  type Signing,
} from "./card.ts";
export { hSd, mandateChallenge } from "./challenge.ts";
export {
  anyItem,
  type Color,
  type Evidence,
  FIELD_IDS,
  type FieldId,
  fieldColors,
  type ZkTlsField,
} from "./colors.ts";
export {
  categoryMask,
  type LeafPreimage,
  type MandateOpening,
  MERCHANT_TREE_CAPACITY,
  type MembershipProof,
  type MerchantTree,
  mandateCommitment,
  mandateOpening,
  merchantLeaf,
  merchantMembership,
  merchantNonMembership,
  merchantTree,
  type NonMembershipProof,
  userKeyHash,
  verifyMerchantMembership,
  verifyMerchantNonMembership,
} from "./commitment.ts";
export {
  CLOSED_MANDATE_AUD,
  CLOSED_MANDATE_TYP,
  ClosedMandateError,
  type ClosedMandateErrorCode,
  type ClosedMandateParams,
  type ClosedMandateVerifyOptions,
  closeMandate,
  issueOpenMandate,
  issueUserCredential,
  type KeyBindingVerifyOptions,
  OPEN_MANDATE_TYP,
  type OpenMandateParams,
  type OpenMandateVerifyOptions,
  type P256PublicJwk,
  readOpenMandate,
  type SaltGenerator,
  USER_CREDENTIAL_TYP,
  USER_CREDENTIAL_VCT,
  type UserAuth,
  type UserCredentialParams,
  type VerifiedClosedMandate,
  type VerifiedCredential,
  type VerifiedOpenMandate,
  verifyClosedMandate,
  verifyCredential,
  verifyKeyBinding,
  verifyOpenMandate,
} from "./credentials.ts";
export {
  ANY_ITEM,
  ANY_MERCHANT,
  CATEGORY_TABLE,
  isMerchantId,
  MAX_LIFETIME_SECONDS,
  type Mandate,
  MandateError,
  MandateSchema,
  MCC_TABLE,
  parseMandate,
  STRING_LIMITS,
} from "./schema.ts";
export {
  buildSdPayload,
  type Disclosed,
  decodeDisclosed,
  decodeMandate,
  isPersonalDisclosure,
  type MerchantView,
  merchantDisclosures,
  PERSONAL_CLAIMS,
  SD_FIELDS,
  withholdPersonal,
} from "./sd.ts";
export {
  RP_ID,
  SPC_INSTRUMENT,
  SPC_PAYEE_ORIGIN,
  type SpcDetails,
  spcDetails,
} from "./spc.ts";
export { TERMS, TERMS_HASH } from "./terms.ts";
