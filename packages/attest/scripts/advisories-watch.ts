/**
 * Fails when Intel's current TCB info for leg A's platform lists a `SWHardeningNeeded` advisory
 * that `ACCEPTED_ADVISORIES` does not hold.
 *
 *   node scripts/advisories-watch.ts [fmspc]
 */
import { unreviewedAdvisories } from "../src/advisories.ts";

const fmspc = process.argv[2] ?? "20A06F000000";
const url = `https://api.trustedservices.intel.com/tdx/certification/v4/tcb?fmspc=${fmspc}`;
const response = await fetch(url);
if (!response.ok) throw new Error(`${url}: ${response.status}`);
const unreviewed = unreviewedAdvisories(await response.text());
if (unreviewed.length > 0) {
  console.error(`Advisories to review for FMSPC ${fmspc}: ${unreviewed.join(", ")}`);
  process.exit(1);
}
console.log(`Every SWHardeningNeeded advisory for FMSPC ${fmspc} is reviewed.`);
