import { paypalConfig } from "./src/config.ts";
import { getDispute, listDisputes } from "./src/disputes.ts";
import { createPayPal } from "./src/sdk.ts";
import { TokenCache } from "./src/token.ts";

const cfg = paypalConfig();
const pp = createPayPal(cfg, new TokenCache(cfg));
const s = await listDisputes(
  pp.fetch,
  process.argv[2] ? { disputedTransactionId: process.argv[2] } : {},
);
for (const i of s.items ?? []) {
  const d: any = await getDispute(pp.fetch, i.dispute_id);
  console.log(
    d.dispute_id,
    d.status,
    d.dispute_life_cycle_stage,
    d.reason,
    d.links?.map((l: any) => l.rel).join(","),
    d.create_time,
  );
}
