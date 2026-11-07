import type { OpenAPIHono } from "@hono/zod-openapi";
import type { PiiValues } from "@keelson/evidence";
import { type Capture, captureEvidence, startRecorder } from "@keelson/evidence/capture";
import { generateHybridIdentity, identityToRecipient } from "age-encryption";
import { chromium } from "playwright";
import { ulid } from "ulid";
import { serve } from "../../../packages/evidence/test/server.ts";

/** A new age identity and the recipient it opens. */
export async function ageKeys(): Promise<{ identity: string; recipient: string }> {
  const identity = await generateHybridIdentity();
  return { identity, recipient: await identityToRecipient(identity) };
}

/**
 * Captures a store page in Chromium the way the agent's driver does. `fill` types into the
 * page's fields before the capture.
 */
export async function capturePage(
  path: "product.html" | "checkout.html",
  opts: { recipient: string; pii?: PiiValues; fill?: Record<string, string> },
): Promise<Capture> {
  const [browser, site] = await Promise.all([chromium.launch(), serve()]);
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const recorder = await startRecorder(page);
    await page.goto(`${site.url}/${path}`);
    await page.locator("body[data-ready]").waitFor({ state: "attached" });
    for (const [selector, value] of Object.entries(opts.fill ?? {})) {
      await page.locator(selector).fill(value);
    }
    const product = await (await fetch(`${site.url}/api/product.json`)).json();
    const cart = await (await fetch(`${site.url}/api/cart.json`)).json();
    const llmObservation = await page.locator("body").ariaSnapshot();
    return await captureEvidence(recorder, {
      product,
      cart,
      llmObservation,
      recipient: opts.recipient,
      ...(opts.pii ? { pii: opts.pii } : {}),
    });
  } finally {
    await browser.close();
    await site.close();
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

/** Captures the store's product page and stores it for `mandateId`; returns its root. */
export async function uploadEvidence(
  app: Pick<OpenAPIHono, "request">,
  mandateId: string,
  headers: Record<string, string>,
): Promise<`0x${string}`> {
  const capture = await capturePage("product.html", await ageKeys());
  const res = await app.request("/v1/evidence", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": ulid(), ...headers },
    body: JSON.stringify(uploadBody(mandateId, capture)),
  });
  if (res.status !== 201) throw new Error(`evidence not stored: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { evidenceRoot: `0x${string}` }).evidenceRoot;
}
