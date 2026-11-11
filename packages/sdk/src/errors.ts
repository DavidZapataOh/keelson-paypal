/** An RFC 9457 problem Keelson's API answered. */
export class KeelsonError extends Error {
  /** The last segment of the problem `type`, e.g. `purchase-exists`. */
  readonly type: string | undefined;

  constructor(
    readonly status: number,
    /** Every member of the problem, e.g. the `approval` of an `approval-required`. */
    readonly problem: Record<string, unknown>,
  ) {
    const type = typeof problem.type === "string" ? problem.type.split("/").at(-1) : undefined;
    const title = typeof problem.title === "string" ? problem.title : `HTTP ${status}`;
    const detail = typeof problem.detail === "string" ? `: ${problem.detail}` : "";
    super(`${title}${detail} (${status}${type ? ` ${type}` : ""})`);
    this.name = "KeelsonError";
    this.type = type;
  }
}

/**
 * The data of a generated call, or its problem as a {@link KeelsonError}.
 *
 * @example
 * const purchase = await unwrap(keelson.getPurchase({ path: { id } }));
 */
export async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response?: Response }>,
): Promise<Exclude<T, undefined>> {
  const { data, error, response } = await call;
  if (error instanceof Error) throw error;
  if (error !== undefined || !response?.ok) {
    throw new KeelsonError(
      response?.status ?? 0,
      typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {},
    );
  }
  return data as Exclude<T, undefined>;
}
