/** Minor units as money, e.g. `9400` USD → `$94.00`. */
export function money(minor: string | bigint, currency: string): string {
  const n = Number(BigInt(minor)) / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
}

export function when(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(iso),
  );
}
