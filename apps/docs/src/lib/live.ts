import data from "../data/live.json";

/** Production's state when the site was built, or `available: false` when it could not be read. */
export type Live =
  | { available: false }
  | {
      available: true;
      fetchedAt: string;
      status: string;
      teeA: string;
      teeB: string;
      paypal: string;
      log: { origin: string; size: number; root: string; witnesses: number };
    };

export const live = data as Live;

/** The build date, as readers see it: "Nov 11, 2026". */
export const builtOn = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
