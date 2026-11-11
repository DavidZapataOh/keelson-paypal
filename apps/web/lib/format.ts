/** Minor units per major unit of an ISO 4217 currency: 100 for USD, 1 for JPY, 1000 for KWD. */
function minorPerMajor(currency: string): number {
  const { maximumFractionDigits } = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).resolvedOptions();
  return 10 ** (maximumFractionDigits ?? 2);
}

/** Minor units as a number of major units, e.g. `9400` USD → `94`, `9400` JPY → `9400`. */
export const major = (minor: string | bigint | number, currency: string): number =>
  Number(BigInt(minor)) / minorPerMajor(currency);

/** Minor units as money, e.g. `9400` USD → `$94.00`. */
export function money(minor: string | bigint, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(
    major(minor, currency),
  );
}

export function when(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}
