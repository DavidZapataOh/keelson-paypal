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

/**
 * SHA-256 of the SubjectPublicKeyInfo each TSA's chain must contain below its root: the issuing
 * timestamping CA where the root also issues other CAs (DigiCert, Sectigo), else the signer itself.
 * A token chaining to a pinned root through any other key is refused.
 */
export const TSA_PINS: Record<TsaId, string[]> = {
  // DigiCert Trusted G4 TimeStamping RSA4096 SHA256 2025 CA1
  digicert: ["6806f8c7f9c356a294a28796c4db6425d132ca877bf4fded0c2bb00e38807c28"],
  // sigstore-tsa
  sigstore: ["2c6f8bfa83ba01e758441c633ff9be1da1ba0c930dbf3d1f222e05a7527709de"],
  // www.freetsa.org TSA certificate
  freetsa: ["fa02bd555e3e483d62b4e70be6218692068d2b0b0a7525db58dcbf2901cdb072"],
  // Sectigo Qualified Time Stamping CA R35
  sectigo: ["dfa41c48c7bc91d8d6436b2b92a68f623ebbda823742e22968fcaeb8f10b7ba9"],
};
