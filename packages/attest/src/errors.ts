export type AttestCode =
  | "cose"
  | "cert_chain"
  | "signature"
  | "debug_mode"
  | "collateral_expired"
  | "tcb_status"
  | "advisory_not_allowed"
  | "rtmr3_mismatch"
  | "binding_mismatch"
  | "measurement_not_allowed"
  | "stale_block"
  | "td_attributes"
  | "xfam"
  | "owner_fields"
  | "device";

/** Why an attestation was rejected. */
export class AttestError extends Error {
  readonly code: AttestCode;

  constructor(code: AttestCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AttestError";
    this.code = code;
  }
}
