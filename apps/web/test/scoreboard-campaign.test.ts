import { expect, test } from "vitest";
import { type CampaignItem, featuredCampaign } from "../lib/scoreboard";

const campaign = (id: string, attacks: number, finished: boolean): CampaignItem => ({
  id,
  startedAt: "2026-11-12T08:00:00.000Z",
  finishedAt: finished ? "2026-11-12T08:30:00.000Z" : null,
  attacks,
});

test("a running campaign is shown first, live", () => {
  expect(featuredCampaign([campaign("running", 10, false), campaign("big", 1008, true)])).toBe(
    "running",
  );
});

test("otherwise the finished campaign with the most attacks, not the newest small one", () => {
  expect(
    featuredCampaign([
      campaign("nightly", 72, true),
      campaign("big", 1008, true),
      campaign("small", 22, true),
    ]),
  ).toBe("big");
});

test("a campaign with no attacks is never shown, and an empty list shows none", () => {
  expect(featuredCampaign([campaign("empty", 0, true), campaign("empty-running", 0, false)])).toBe(
    undefined,
  );
  expect(featuredCampaign([])).toBe(undefined);
});

test("of equal size, the newest (listed first) wins", () => {
  expect(featuredCampaign([campaign("newer", 72, true), campaign("older", 72, true)])).toBe(
    "newer",
  );
});
