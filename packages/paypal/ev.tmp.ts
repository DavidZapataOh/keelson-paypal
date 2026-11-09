import { paypalConfig } from "./src/config.ts";
import { getDispute } from "./src/disputes.ts";
import { createPayPal } from "./src/sdk.ts";
import { TokenCache } from "./src/token.ts";

const cfg = paypalConfig();
const pp = createPayPal(cfg, new TokenCache(cfg));
const d: any = await getDispute(pp.fetch, process.argv[2]!);
console.log(d.status, d.update_time, JSON.stringify(d.evidences, null, 1).slice(0, 3000));
