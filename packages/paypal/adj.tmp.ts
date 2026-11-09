import { paypalConfig } from "./src/config.ts";
import { adjudicate } from "./src/disputes.ts";
import { PayPalError } from "./src/errors.ts";
import { createPayPal } from "./src/sdk.ts";
import { TokenCache } from "./src/token.ts";

const cfg = paypalConfig();
const pp = createPayPal(cfg, new TokenCache(cfg));
try {
  console.log(JSON.stringify(await adjudicate(pp.fetch, process.argv[2]!, "SELLER_FAVOR")));
} catch (e) {
  if (e instanceof PayPalError) console.log(e.status, e.name, JSON.stringify(e.details), e.debugId);
  else throw e;
}
