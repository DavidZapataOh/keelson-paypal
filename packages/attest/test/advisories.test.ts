import { describe, expect, test } from "vitest";
import { ACCEPTED_ADVISORIES, unreviewedAdvisories } from "../src/advisories.ts";
import { tdxEvidence } from "./evidence.ts";

const tcbInfo = (levels: object[], modules: object[] = []) =>
  JSON.stringify({ tcbLevels: levels, tdxModuleIdentities: modules });

describe("ACCEPTED_ADVISORIES", () => {
  test("names Intel advisories, each with the reason it was accepted", () => {
    for (const [id, reason] of Object.entries(ACCEPTED_ADVISORIES)) {
      expect(id).toMatch(/^INTEL-SA-\d{5}$/);
      expect(reason.trim()).not.toBe("");
    }
  });

  test("covers every SWHardeningNeeded advisory in leg A's collateral", () => {
    expect(unreviewedAdvisories(tdxEvidence.collateral.tcb_info)).toEqual([]);
  });
});

describe("unreviewedAdvisories", () => {
  test("lists advisories of platform and TDX module SWHardeningNeeded levels not yet reviewed", () => {
    const info = tcbInfo(
      [
        { tcbStatus: "UpToDate" },
        { tcbStatus: "SWHardeningNeeded", advisoryIDs: ["INTEL-SA-99998", "INTEL-SA-99999"] },
        { tcbStatus: "OutOfDate", advisoryIDs: ["INTEL-SA-99997"] },
      ],
      [
        {
          tcbLevels: [
            { tcbStatus: "SWHardeningNeeded", advisoryIDs: ["INTEL-SA-99996", "INTEL-SA-99999"] },
          ],
        },
      ],
    );
    expect(unreviewedAdvisories(info)).toEqual([
      "INTEL-SA-99996",
      "INTEL-SA-99998",
      "INTEL-SA-99999",
    ]);
  });

  test("accepts Intel's response envelope as well as the bare TCB info", () => {
    const bare = JSON.parse(
      tcbInfo([{ tcbStatus: "SWHardeningNeeded", advisoryIDs: ["INTEL-SA-99999"] }]),
    );
    expect(unreviewedAdvisories(JSON.stringify({ tcbInfo: bare, signature: "00" }))).toEqual([
      "INTEL-SA-99999",
    ]);
  });
});
