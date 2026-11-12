import { readFileSync } from "node:fs";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ActivityEntry, activityMatch, paypalTransactionId } from "../src/live.ts";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/paypal/activity.json", import.meta.url), "utf8"),
) as {
  details: Record<string, { data: ActivityEntry }>;
  rows: Record<string, { id: string; text: string }[]>;
};
const entries = (account: string) =>
  Object.entries(recorded.details)
    .filter(([k]) => k.startsWith(`${account}:`))
    .map(([, v]) => v.data);

describe("the buyer's PayPal activity entry for the payment just made", () => {
  test("is the one authorization or payment of the order's amount since the pay click", () => {
    // In es-CO, the row reads "$2,95"; PayPal's structured gross is USD 2.95.
    expect(
      activityMatch(entries("CO"), {
        currency: "USD",
        value: "2.95",
        since: new Date("2026-11-12T06:45:00Z"),
      }),
    ).toBe("2TX619119H4252218");
    expect(
      activityMatch(entries("BUYER"), {
        currency: "USD",
        value: "2.95",
        since: new Date("2026-11-12T05:18:00Z"),
      }),
    ).toBe("1DS97980237733941");
    // PayPal writes the gross "8"; the order's total is 8.00.
    expect(
      activityMatch(entries("BUYER"), {
        currency: "USD",
        value: "8.00",
        since: new Date("2026-11-12T06:30:00Z"),
      }),
    ).toBe("38A17830LA358333N");
  });

  test("is none when two entries match, or none does", () => {
    const buyer = entries("BUYER");
    const since = new Date("2026-11-12T06:00:00Z");
    expect(activityMatch(buyer, { currency: "USD", value: "8.00", since })).toBeUndefined();
    expect(
      activityMatch(buyer, { currency: "EUR", value: "2.95", since: new Date(0) }),
    ).toBeUndefined();
    expect(
      activityMatch(buyer, {
        currency: "USD",
        value: "2.95",
        since: new Date("2026-11-12T06:00:00Z"),
      }),
    ).toBeUndefined();
    // A correction (a transfer from PayPal) is no payment, whatever its amount.
    expect(
      activityMatch(entries("CO"), { currency: "USD", value: "5000", since: new Date(0) }),
    ).toBeUndefined();
  });
});

describe("reading it from PayPal's activity page", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  test("opens each listed entry's details and takes only the matching id", async () => {
    const context = await browser.newContext();
    const asked: string[] = [];
    const rows = recorded.rows.CO ?? [];
    await context.route("https://www.paypal.com/myaccount/activities/**", async (r) => {
      const path = new URL(r.request().url()).pathname;
      const id = /\/details\/inline\/([0-9A-Z]{17})$/.exec(path)?.[1];
      if (id) {
        asked.push(id);
        return r.fulfill({ json: recorded.details[`CO:${id}`] ?? {}, status: 200 });
      }
      return r.fulfill({
        contentType: "text/html",
        body: `<html><body><a href="/myaccount/activities/">Activity</a>${rows
          .map((x) => `<div class="list_item js_transactionItem-${x.id}">${x.text}</div>`)
          .join("")}</body></html>`,
      });
    });
    const confirmation = await context.newPage();
    await confirmation.setContent("<p>Thank you for your order.</p>");
    try {
      expect(
        await paypalTransactionId(context, confirmation, {
          currency: "USD",
          value: "2.95",
          since: new Date("2026-11-12T06:45:00Z"),
        }),
      ).toBe("2TX619119H4252218");
      expect(asked).toEqual(rows.map((x) => x.id));
      expect(
        await paypalTransactionId(context, confirmation, {
          currency: "USD",
          value: "3.95",
          since: new Date("2026-11-12T06:45:00Z"),
        }),
      ).toBeUndefined();
    } finally {
      await context.close();
    }
  });
});
