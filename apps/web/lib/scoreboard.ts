import { API } from "./config";

/** A proportion and its 95 % interval, in parts per million, as the API publishes it. */
export interface Rate {
  method: "wilson" | "clopper-pearson";
  k: number;
  n: number;
  ppm: number | null;
  lo_ppm: number;
  hi_ppm: number;
}

export interface Row {
  backbone: string;
  split: "seen" | "holdout" | "all";
  models: string[];
  attacks: number;
  proposed: number;
  asr: Rate;
  escape: Rate;
  false_blocks: Rate;
  utility: Rate;
  amber: { k: number; n: number; ppm: number | null };
  usd_micros: number;
}

export interface Scoreboard {
  v: "keelson.scoreboard/1";
  campaign: string;
  started: string;
  commit: string;
  lines: number;
  head: string;
  complete: boolean;
  attacks: number;
  mutator_usd_micros: number | null;
  rows: Row[];
}

export interface CampaignItem {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  attacks: number;
}

/**
 * The campaign the scoreboard opens on, of a newest-first list: one still running, live;
 * otherwise the finished one with the most attacks, whose bounds are the tightest.
 */
export function featuredCampaign(list: readonly CampaignItem[]): string | undefined {
  const attacked = list.filter((c) => c.attacks > 0);
  const running = attacked.find((c) => c.finishedAt === null);
  if (running) return running.id;
  return attacked.reduce<CampaignItem | undefined>(
    (best, c) => (best === undefined || c.attacks > best.attacks ? c : best),
    undefined,
  )?.id;
}

export const campaignUrl = (id: string, path: "ledger" | "scoreboard" | "scoreboard/stream") =>
  `${API}/v1/redteam/campaigns/${id}/${path}`;

export async function campaigns(): Promise<CampaignItem[]> {
  const res = await fetch(`${API}/v1/redteam/campaigns`);
  if (!res.ok) throw new Error(`campaigns: ${res.status}`);
  return ((await res.json()) as { campaigns: CampaignItem[] }).campaigns;
}

export async function scoreboard(id: string): Promise<Scoreboard> {
  const res = await fetch(campaignUrl(id, "scoreboard"));
  if (!res.ok) throw new Error(`scoreboard: ${res.status}`);
  return (await res.json()) as Scoreboard;
}

/** Parts per million as a percentage to two decimals: `15430` → `1.54%`; `up` rounds upper limits up. */
export function percent(ppm: number, up = false): string {
  const hundredths = up ? Math.ceil(ppm / 100) : Math.round(ppm / 100);
  return `${(hundredths / 100).toFixed(hundredths % 100 === 0 ? 0 : 2)}%`;
}

export function usd(micros: number): string {
  return `$${(micros / 1e6).toFixed(2)}`;
}
