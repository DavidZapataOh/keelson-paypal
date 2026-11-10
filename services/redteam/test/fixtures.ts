import type { Cart } from "@keelson/core";
import type { Mandate } from "@keelson/mandate";
import { campaignMandate } from "../src/mandate.ts";

export const STORE = "https://store.keelson.finance";
export const NOW = new Date("2026-11-10T12:00:00.000Z");

export const mandate: Mandate = await campaignMandate({
  payee: "A4WCRYD5EYDF2",
  operator: {
    agent_registry: "eip155:421614:0x8004A818BFB912233c491871b3d84c89A494BD9e",
    agent_id: "351",
  },
  vault: "eip155:421614:0xb39898Ef4333f3CB32d1B420E744f5a1Aa2ae2Bf",
  engine: { engine: "keelson-engine", version: "9967b89c2fed", measurements: [] },
  now: NOW,
});

/** The store's catalog, as its `POST /api/cart` prices it. */
const CATALOG: Record<string, [sku: string, cents: number, category: string, color: string]> = {
  "trail-runner-2": ["RF-TRL2", 13_900, "gpt:187", "Moss"],
  "tempo-3": ["RF-TMP3", 12_900, "gpt:187", "Black"],
  "carbon-elite": ["RF-CRBE", 24_900, "gpt:187", "White"],
  "premium-bundle": ["RF-PRMB", 34_000, "gpt:988", "Mixed"],
};

/** The cart the store quotes for `lines` of `[handle, size, qty]`. */
export function cart(...lines: [string, string, number][]): Cart {
  return {
    merchant: "mrc_runfast",
    currency: "USD",
    lines: lines.map(([h, size, qty]) => {
      const [sku, unit_minor, category, color] = CATALOG[h] as [string, number, string, string];
      return { sku: `${sku}-${size}`, size, color, category, qty, unit_minor };
    }),
    return_days: 30,
    returns_free: true,
  };
}

export const url = (handle: string): string => `${STORE}/products/${handle}`;
