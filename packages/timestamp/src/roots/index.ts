import type { TsaId } from "../tsas.ts";
import { DIGICERT_TRUSTED_ROOT_G4_PEM } from "./digicert-trusted-root-g4.ts";
import { FREETSA_ROOT_PEM } from "./freetsa.ts";
import { SECTIGO_QUALIFIED_ROOT_R45_PEM } from "./sectigo-qualified-r45.ts";
import { SIGSTORE_TSA_ROOT_PEM, SIGSTORE_TSA_SIGNER_PEM } from "./sigstore-tsa.ts";

/** The pinned root of each TSA, PEM. */
export const TSA_ROOTS: Record<TsaId, string> = {
  digicert: DIGICERT_TRUSTED_ROOT_G4_PEM,
  sigstore: SIGSTORE_TSA_ROOT_PEM,
  freetsa: FREETSA_ROOT_PEM,
  sectigo: SECTIGO_QUALIFIED_ROOT_R45_PEM,
};

/** Pinned certificates a token may omit: Sigstore tokens carry only the signer. */
export const TSA_INTERMEDIATES: Partial<Record<TsaId, string>> = {
  sigstore: SIGSTORE_TSA_SIGNER_PEM,
};
