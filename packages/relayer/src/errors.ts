export type RelayerErrorCode =
  | "not-allowed"
  | "key-conflict"
  | "simulation-reverted"
  | "gas-price-cap"
  | "gas-limit"
  | "relayer-low-balance"
  | "countersign-mode"
  | "chain-unavailable";

const STATUS: Record<RelayerErrorCode, 403 | 409 | 422 | 503> = {
  "not-allowed": 403,
  "key-conflict": 409,
  "simulation-reverted": 422,
  "countersign-mode": 422,
  "gas-price-cap": 503,
  "gas-limit": 422,
  "relayer-low-balance": 503,
  "chain-unavailable": 503,
};

/** A submission the relayer refused or could not send; nothing was spent unless `code` says otherwise. */
export class RelayerError extends Error {
  override name = "RelayerError";
  readonly code: RelayerErrorCode;
  readonly status: 403 | 409 | 422 | 503;
  readonly detail: unknown;

  constructor(code: RelayerErrorCode, message: string, detail?: unknown) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.detail = detail;
  }
}
