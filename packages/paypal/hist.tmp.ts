import { paypalConfig } from "./src/config.ts";
import { getDispute } from "./src/disputes.ts";
import { createPayPal } from "./src/sdk.ts";
import { TokenCache } from "./src/token.ts";

const cfg = paypalConfig();
const pp = createPayPal(cfg, new TokenCache(cfg));
const d: any = await getDispute(pp.fetch, process.argv[2]!);
console.log(
  d.create_time,
  d.update_time,
  JSON.stringify(d.dispute_outcome),
  JSON.stringify(
    (d.evidences ?? []).map((e: any) => [e.evidence_type, e.source, e.date, e.action_info]),
  ),
  JSON.stringify(d.adjudications ?? null),
  JSON.stringify(d.money_movements ?? null).slice(0, 300),
);
