/**
 * The Keelson mandate model: the `keelson.mandate.1` schema, its selective disclosure, the
 * commitment `C_m` and passkey challenge `M`, the user credential and open mandate, and the card
 * the user signs. The Rust engine's `keelson-mandate` crate mirrors every function that both sides
 * run, pinned by golden vectors.
 *
 * @packageDocumentation
 */
export {
  type Answerer,
  CATEGORY_LABELS,
  type Card,
  type CardRow,
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
  MERCHANT_TREE_CAPACITY,
  type MembershipProof,
  type MerchantTree,
  mandateCommitment,
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
  issueOpenMandate,
  issueUserCredential,
  OPEN_MANDATE_TYP,
  type OpenMandateParams,
  type OpenMandateVerifyOptions,
  type P256PublicJwk,
  USER_CREDENTIAL_TYP,
  USER_CREDENTIAL_VCT,
  type UserAuth,
  type UserCredentialParams,
  type VerifiedCredential,
  type VerifiedOpenMandate,
  verifyCredential,
} from "./credentials.ts";
export {
  ANY_ITEM,
  CATEGORY_TABLE,
  isMerchantId,
  MAX_LIFETIME_SECONDS,
  type Mandate,
  MandateError,
  MandateSchema,
  parseMandate,
  STRING_LIMITS,
} from "./schema.ts";
export {
  buildSdPayload,
  type Disclosed,
  decodeDisclosed,
  decodeMandate,
  type MerchantView,
  merchantDisclosures,
  SD_FIELDS,
} from "./sd.ts";
export {
  RP_ID,
  SPC_INSTRUMENT,
  SPC_PAYEE_ORIGIN,
  type SpcDetails,
  spcDetails,
} from "./spc.ts";
