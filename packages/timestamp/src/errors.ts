export type TimestampCode =
  | "tsa-http"
  | "tsa-timeout"
  | "tsa-content-type"
  | "tsa-status"
  | "tsa-imprint"
  | "tsa-nonce"
  | "tsa-parse"
  | "tsa-time"
  | "tsa-signature"
  | "tsa-chain"
  | "tsa-eku"
  | "tsa-ess-cert"
  | "tsa-validity";

/** Why a timestamp request or token was rejected. */
export class TimestampError extends Error {
  readonly code: TimestampCode;

  constructor(code: TimestampCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TimestampError";
    this.code = code;
  }
}
