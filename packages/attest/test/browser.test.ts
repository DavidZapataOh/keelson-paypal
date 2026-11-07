import { jcs } from "@keelson/core";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, expect, test } from "vitest";
import { bundleAttest } from "../scripts/bundle.ts";
import { type Expectations, type SignerAttestation, verifyLegs } from "../src/signer.ts";
import { nitroEvidence, tdxEvidence } from "./evidence.ts";
import { legs, plain } from "./legs.ts";

let browser: Browser;
let code: string;

beforeAll(async () => {
  code = (await bundleAttest()).code;
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

test("the browser returns the bytes Node returns for the same evidence", async () => {
  const input = await legs();
  const nodeResult = await verifyLegs(...input);

  const page = await browser.newPage();
  await page.route("http://localhost/", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("http://localhost/");
  await page.addScriptTag({ content: code });
  const inBrowser = await page.evaluate(
    async ([a, b]) => {
      const dated = ([att, e]: [unknown, Record<string, unknown>]) =>
        [att, { ...e, now: new Date(e.now as string) }] as never;
      const [x, y] = await (
        globalThis as unknown as { attest: { verifyLegs: (...a: unknown[]) => Promise<unknown[]> } }
      ).attest.verifyLegs(dated(a), dated(b));
      return JSON.stringify([x, y], (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    },
    [serial(input[0]), serial(input[1])] as const,
  );
  await page.close();

  expect(jcs(JSON.parse(inBrowser))).toBe(jcs(plain(nodeResult)));
});

function serial([att, e]: readonly [SignerAttestation, Expectations]) {
  return [att, { ...e, now: e.now.toISOString() }] as [SignerAttestation, Record<string, unknown>];
}

test("the evidence under test is the captured evidence", () => {
  expect(tdxEvidence.leg).toBe("tdx");
  expect(nitroEvidence.leg).toBe("nitro");
});
