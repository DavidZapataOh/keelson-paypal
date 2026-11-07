import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Decrypter, generateHybridIdentity, identityToRecipient } from "age-encryption";
import { type Browser, type BrowserContext, chromium, type Page } from "playwright";
import { PNG } from "pngjs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Capture, captureEvidence, startRecorder } from "../src/capture/index.ts";
import {
  containsPii,
  type DomV1,
  ITEM_TYPES,
  MIN_SUBSTRING_PII,
  type PiiValues,
  redactJson,
  redactText,
} from "../src/index.ts";
import { serve } from "./server.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (the PayPal sandbox buyer)`);
  return value;
}

/** The sandbox buyer as PayPal returns them on an approved order with the address on file. */
const buyer = {
  email: required("PAYPAL_SANDBOX_BUYER_EMAIL"),
  name: required("PAYPAL_SANDBOX_BUYER_NAME"),
  address: JSON.parse(required("PAYPAL_SANDBOX_BUYER_ADDRESS")) as Record<
    "line1" | "city" | "state" | "postal" | "country",
    string
  >,
};
const pii: PiiValues = {
  name: buyer.name,
  email: buyer.email,
  address: [
    buyer.address.line1,
    buyer.address.city,
    buyer.address.state,
    buyer.address.postal,
    buyer.address.country,
  ],
};
const values = [buyer.name, buyer.email, ...(pii.address ?? [])];

let browser: Browser;
let context: BrowserContext;
let site: Awaited<ReturnType<typeof serve>>;
let identity: string;
let recipient: string;

beforeAll(async () => {
  [browser, site] = await Promise.all([chromium.launch(), serve()]);
  context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  identity = await generateHybridIdentity();
  recipient = await identityToRecipient(identity);
});
afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("redaction", () => {
  test("known values become [redacted:<kind>], short ones only as whole values", () => {
    const entries = [
      { kind: "name" as const, value: "Ada Lovelace" },
      { kind: "address" as const, value: "CA" },
    ];
    expect(redactText("Shipping to Ada Lovelace, CA", entries)).toEqual({
      text: "Shipping to [redacted:name], CA",
      hits: 1,
    });
    expect(redactText("CA", entries).text).toBe("[redacted:address]");
    expect(redactText('<input value="CA">', entries).text).toBe(
      '<input value="[redacted:address]">',
    );
    expect(redactText("CAD and USD", entries).hits).toBe(0);
    expect(redactText("write to a.b@example.org or +14155550100", []).text).toBe(
      "write to [redacted:email] or [redacted:phone]",
    );
    expect(redactText("cid:css-0@mhtml.blink logo@2x.png", []).hits).toBe(0);
    expect(redactJson({ to: { email: "a.b@example.org" }, qty: 2 }, []).value).toEqual({
      to: { email: "[redacted:email]" },
      qty: 2,
    });
  });
});

describe("checkout capture", () => {
  let page: Page;
  let capture: Capture;
  beforeAll(async () => {
    page = await context.newPage();
    const recorder = await startRecorder(page);
    await page.goto(`${site.url}/checkout.html`);
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    await page.locator("#name").fill(buyer.name);
    await page.locator("#email").fill(buyer.email);
    await page.locator("#address1").fill(buyer.address.line1);
    await page.locator("#city").fill(buyer.address.city);
    await page.locator("#state").fill(buyer.address.state);
    await page.locator("#zip").fill(buyer.address.postal);
    await page.locator("#country").fill(buyer.address.country);
    await page.locator("#pay").focus();
    const cart = await (await fetch(`${site.url}/api/cart.json`)).json();
    const llmObservation = await page.locator("body").ariaSnapshot();
    expect(llmObservation).toContain(buyer.email);
    capture = await captureEvidence(recorder, {
      product: {},
      cart,
      llmObservation,
      pii,
      recipient,
    });
    await recorder.stop();
  });
  afterAll(async () => {
    await page?.close();
  });

  const publicItems = () => capture.items.filter((i) => !i.type.endsWith(".original"));

  test("no public item holds a PII value", () => {
    for (const item of publicItems()) {
      const raw = Buffer.from(item.bytes).toString("latin1").toLowerCase();
      for (const v of values.filter((x) => x.length >= MIN_SUBSTRING_PII)) {
        expect(raw.includes(v.toLowerCase()), `${item.type} holds a PII value`).toBe(false);
      }
      expect(containsPii(item.mediaType, item.bytes), item.type).toBe(false);
    }
    const dom = JSON.parse(
      decode(publicItems().find((i) => i.type === "dom.snapshot")?.bytes ?? new Uint8Array()),
    ) as DomV1;
    const fields = dom.nodes.filter((n) => n.tag === "input");
    expect(fields.map((f) => f.value)).toEqual([
      "[redacted:name]",
      "[redacted:email]",
      undefined,
      "[redacted:address]",
      "[redacted:address]",
      "[redacted:address]",
      "[redacted:address]",
      "[redacted:address]",
    ]);
  });

  test("the redacted MHTML still opens in Chromium", async () => {
    const dir = await mkdtemp(join(tmpdir(), "keelson-mhtml-"));
    const file = join(dir, "checkout.mhtml");
    await writeFile(file, publicItems().find((i) => i.type === "mhtml")?.bytes ?? new Uint8Array());
    const opened = await context.newPage();
    await opened.goto(pathToFileURL(file).href);
    await expect(opened.locator("#ship-name").textContent()).resolves.toBe("[redacted:name]");
    await expect(opened.locator("#total").textContent()).resolves.toBe("Total $129.00");
    await opened.close();
  });

  test("the masked areas of the public screenshot are solid black", async () => {
    const png = PNG.sync.read(
      Buffer.from(publicItems().find((i) => i.type === "screenshot")?.bytes ?? []),
    );
    const boxes = await Promise.all(
      ["#name", "#email", "#address1", "#city", "#state", "#zip", "#country", "#ship-name"].map(
        (s) => page.locator(s).boundingBox(),
      ),
    );
    for (const box of boxes) {
      expect(box).not.toBeNull();
      const { x, y, width, height } = box as NonNullable<typeof box>;
      for (let py = Math.ceil(y) + 1; py < Math.floor(y + height) - 1; py++) {
        for (let px = Math.ceil(x) + 1; px < Math.floor(x + width) - 1; px++) {
          const o = (py * png.width + px) * 4;
          expect([png.data[o], png.data[o + 1], png.data[o + 2]]).toEqual([0, 0, 0]);
        }
      }
    }
  });

  test("the originals are sealed in table order and open with the identity", async () => {
    const originals = capture.items.filter((i) => i.type.endsWith(".original"));
    const types = originals.map((i) => i.type.replace(/\.original$/, ""));
    expect(types).toEqual(ITEM_TYPES.filter((t) => types.includes(t)));
    expect(types).toEqual(
      expect.arrayContaining(["llm.observation", "dom.snapshot", "ax.tree", "screenshot"]),
    );
    const d = new Decrypter();
    d.addIdentity(identity);
    for (const item of originals) {
      expect(item.mediaType).toBe("application/octet-stream");
      const plain = await d.decrypt(item.bytes);
      if (item.type === "screenshot.original") {
        const png = PNG.sync.read(Buffer.from(plain));
        expect([png.width, png.height]).toEqual([1280, 720]);
      } else {
        const text = decode(plain).toLowerCase();
        expect(
          values.some((v) => v.length >= MIN_SUBSTRING_PII && text.includes(v.toLowerCase())),
        ).toBe(true);
        if (item.type !== "mhtml.original") expect(text).toContain(buyer.email.toLowerCase());
      }
    }
  });

  test("a page without PII seals no originals", async () => {
    const product = await context.newPage();
    const recorder = await startRecorder(product);
    await product.goto(`${site.url}/product.html`);
    await product.locator("body[data-ready]").waitFor({ state: "attached" });
    const llmObservation = await product.locator("body").ariaSnapshot();
    const clean = await captureEvidence(recorder, {
      product: {},
      cart: {},
      llmObservation,
      pii,
      recipient,
    });
    await recorder.stop();
    await product.close();
    expect(clean.items.some((i) => i.type.endsWith(".original"))).toBe(false);
    expect(clean.items.map((i) => i.type)).toEqual([...ITEM_TYPES]);
  });
});
