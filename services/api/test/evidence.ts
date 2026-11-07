import type { OpenAPIHono } from "@hono/zod-openapi";
import type { PiiValues } from "@keelson/evidence";
import { type Capture, captureEvidence, startRecorder } from "@keelson/evidence/capture";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { type Browser, chromium } from "playwright";
import { ulid } from "ulid";
import { serve } from "../../../packages/evidence/test/server.ts";

/** A new age identity and the recipient it opens. */
export async function ageKeys(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateHybridIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

interface CaptureOptions {
  recipient: string;
  pii?: PiiValues;
  /** Typed into the page's fields before the capture. */
  fill?: Record<string, string>;
  /** The cart the agent read; the store's own cart response when absent. */
  cart?: unknown;
}

/** Captures the store pages in one Chromium the way the agent's driver does. */
export class StoreCapture {
  private browser?: Browser;
  private site?: Awaited<ReturnType<typeof serve>>;

  async capture(path: "product.html" | "checkout.html", opts: CaptureOptions): Promise<Capture> {
    this.browser ??= await chromium.launch();
    this.site ??= await serve();
    const site = this.site;
    const context = await this.browser.newContext({ viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      const recorder = await startRecorder(page);
      await page.goto(`${site.url}/${path}`);
      await page.locator("body[data-ready]").waitFor({ state: "attached" });
      for (const [selector, value] of Object.entries(opts.fill ?? {})) {
        await page.locator(selector).fill(value);
      }
      const product = await (await fetch(`${site.url}/api/product.json`)).json();
      const cart = opts.cart ?? (await (await fetch(`${site.url}/api/cart.json`)).json());
      const llmObservation = await page.locator("body").ariaSnapshot();
      return await captureEvidence(recorder, {
        product,
        cart,
        llmObservation,
        recipient: opts.recipient,
        ...(opts.pii ? { pii: opts.pii } : {}),
      });
    } finally {
      await context.close();
    }
  }

  async close(): Promise<void> {
    await this.browser?.close();
    await this.site?.close();
  }
}

/** The `POST /v1/evidence` body for a capture. */
export function uploadBody(mandateId: string, capture: Pick<Capture, "manifest" | "items">) {
  return {
    mandateId,
    manifest: capture.manifest,
    items: capture.items.map((i) => ({
      type: i.type,
      mediaType: i.mediaType,
      salt: Buffer.from(i.salt).toString("base64"),
      bytes: Buffer.from(i.bytes).toString("base64"),
    })),
  };
}

/**
 * Stores evidence for the countersign of `cart`: each call captures the product page with that
 * cart and fresh salts, so each countersign binds a root of its own.
 */
export class EvidenceUploader {
  private readonly store = new StoreCapture();
  private keys?: { recipient: string };

  async upload(
    app: Pick<OpenAPIHono, "request">,
    mandateId: string,
    cart: unknown,
    headers: Record<string, string>,
  ): Promise<`0x${string}`> {
    this.keys ??= await ageKeys();
    const capture = await this.store.capture("product.html", {
      recipient: this.keys.recipient,
      cart,
    });
    const res = await app.request("/v1/evidence", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
      body: JSON.stringify(uploadBody(mandateId, capture)),
    });
    if (res.status !== 201)
      throw new Error(`evidence not stored: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { evidenceRoot: `0x${string}` }).evidenceRoot;
  }

  close(): Promise<void> {
    return this.store.close();
  }
}
