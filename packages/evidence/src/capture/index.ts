import { Buffer } from "node:buffer";
import { Encrypter } from "age-encryption";
import { PNG } from "pngjs";
import { axBytes, normalizeAx } from "../ax.ts";
import { canonicalBytes } from "../canonical.ts";
import { COMPUTED_STYLES, type DomSnapshot, domBytes, normalizeDom } from "../dom.ts";
import { detectHiddenText, type HiddenTextFinding } from "../hidden.ts";
import { type ItemType, MEDIA_TYPES, ORIGINAL_MEDIA_TYPE, type SealedItem } from "../items.ts";
import { buildManifest, type Manifest } from "../manifest.ts";
import {
  MIN_SUBSTRING_PII,
  type PiiEntry,
  type PiiValues,
  piiEntries,
  redactJson,
  redactText,
} from "../pii.ts";
import { buildHar } from "./har.ts";
import { normalizeMhtml } from "./mhtml.ts";
import type { Recorder } from "./recorder.ts";
import { fieldEntries, redactAx, redactDom, redactHar, redactMhtml } from "./redact.ts";

export { buildHar, type Har, type HarEntry, MAX_HAR_BODY } from "./har.ts";
export { normalizeMhtml } from "./mhtml.ts";
export { type RecordedRequest, type Recorder, startRecorder } from "./recorder.ts";

export interface CaptureInput {
  /** The product API response the agent read. */
  product: unknown;
  /** The cart API response the agent read. */
  cart: unknown;
  /** The textual observation the model received. */
  llmObservation: string;
  /** What the user is known to be, from the PayPal order; redacted wherever it appears. */
  pii?: PiiValues;
  /** The age recipient that seals the unredacted originals (`KEELSON_EVIDENCE_AGE_RECIPIENT`). */
  recipient: string;
  /** Pins the salts of the public items, in item order; only for tests. */
  salts?: Uint8Array[];
}

export interface Capture {
  manifest: Manifest;
  items: SealedItem[];
  /** Text the agent could read and a person could not. */
  findings: HiddenTextFinding[];
  /** Milliseconds per step. */
  timings: Record<string, number>;
}

const encoder = new TextEncoder();

async function timed<T>(
  timings: Record<string, number>,
  name: string,
  f: () => Promise<T>,
): Promise<T> {
  const start = performance.now();
  try {
    return await f();
  } finally {
    timings[name] = performance.now() - start;
  }
}

type Rect = [x: number, y: number, w: number, h: number];

/**
 * The device-pixel rectangles a person must not see: every password field, every filled form
 * field, and every element whose text holds a known or typed value. One round trip, so it costs
 * the same on a remote browser.
 */
function piiRects(recorder: Recorder, known: readonly PiiEntry[]): Promise<Rect[]> {
  const values = known.filter((e) => e.value.length >= MIN_SUBSTRING_PII).map((e) => e.value);
  return recorder.page.evaluate(
    ([wanted, min]) => {
      const dpr = window.devicePixelRatio || 1;
      const rects: [number, number, number, number][] = [];
      const push = (r: DOMRect) => {
        if (r.width > 0 && r.height > 0)
          rects.push([r.left * dpr, r.top * dpr, r.width * dpr, r.height * dpr]);
      };
      const needles = wanted.map((v) => v.toLowerCase());
      const fields = document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input:not([type=submit i]):not([type=button i]):not([type=reset i]):not([type=image i]):not([type=hidden i]), textarea",
      );
      for (const field of fields) {
        const value = field.value.trim();
        if (value === "" && field.type !== "password") continue;
        push(field.getBoundingClientRect());
        if (value.length >= min) needles.push(value.toLowerCase());
      }
      if (needles.length > 0) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = (n.nodeValue ?? "").toLowerCase();
          if (n.parentElement && needles.some((v) => text.includes(v))) {
            push(n.parentElement.getBoundingClientRect());
          }
        }
      }
      return rects;
    },
    [values, MIN_SUBSTRING_PII] as const,
  );
}

/** Paints the rectangles solid `#000000` over a PNG. */
function maskPng(png: Uint8Array, rects: readonly Rect[]): Uint8Array {
  const image = PNG.sync.read(Buffer.from(png));
  for (const [x, y, w, h] of rects) {
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(image.width, Math.ceil(x + w));
    const y1 = Math.min(image.height, Math.ceil(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const o = (py * image.width + px) * 4;
        image.data[o] = 0;
        image.data[o + 1] = 0;
        image.data[o + 2] = 0;
        image.data[o + 3] = 255;
      }
    }
  }
  return Uint8Array.from(PNG.sync.write(image, { deflateLevel: 1 }));
}

/**
 * Captures what the agent saw at decision time through the recorder's CDP session, redacts PII
 * from every public item, seals the unredacted originals with age and builds the salted manifest
 * whose root is the `evidenceRoot`.
 */
export async function captureEvidence(recorder: Recorder, input: CaptureInput): Promise<Capture> {
  const timings: Record<string, number> = {};
  const start = performance.now();
  const { session } = recorder;
  const known = piiEntries(input.pii);

  // The boxes to mask are read before the screenshot, so both describe the same layout.
  const masked = async () => {
    const rects = await timed(timings, "piiRects", () => piiRects(recorder, known));
    const shot = await timed(timings, "screenshot", () =>
      session.send("Page.captureScreenshot", { format: "png" }),
    );
    return { rects, shot };
  };
  const [{ rects, shot: screenshot }, snapshot, ax, mhtml] = await Promise.all([
    masked(),
    timed(timings, "domSnapshot", () =>
      session.send("DOMSnapshot.captureSnapshot", {
        computedStyles: [...COMPUTED_STYLES],
        includeDOMRects: true,
        includePaintOrder: true,
        includeBlendedBackgroundColors: true,
        includeTextColorOpacities: true,
      }),
    ),
    timed(timings, "ax", () => session.send("Accessibility.getFullAXTree", {})),
    timed(timings, "mhtml", () => session.send("Page.captureSnapshot", { format: "mhtml" })),
    timed(timings, "har", () => recorder.settled()),
  ]);

  let mark = performance.now();
  const dom = normalizeDom(snapshot as DomSnapshot, { baseUrl: recorder.page.url() });
  const axTree = normalizeAx(ax.nodes);
  const har = buildHar(recorder.requests);
  const page = normalizeMhtml(mhtml.data);
  timings.normalize = performance.now() - mark;

  mark = performance.now();
  const entries = piiEntries(input.pii, fieldEntries(dom));
  const product = redactJson(input.product, entries);
  const cart = redactJson(input.cart, entries);
  const observation = redactText(input.llmObservation, entries);
  const publicDom = redactDom(dom, entries);
  const publicAx = redactAx(axTree, entries);
  const publicMhtml = redactMhtml(page, entries);
  const publicHar = redactHar(har, entries);
  timings.redaction = performance.now() - mark;

  mark = performance.now();
  const findings = detectHiddenText(publicDom.dom, publicAx.ax, observation.text);
  timings.detector = performance.now() - mark;

  const png = Uint8Array.from(Buffer.from(screenshot.data, "base64"));
  mark = performance.now();
  const covered = rects.length > 0 ? maskPng(png, rects) : null;
  timings.mask = performance.now() - mark;
  const rows: [ItemType, Uint8Array, Uint8Array | null][] = [
    [
      "api.product",
      canonicalBytes(product.value),
      product.hits ? canonicalBytes(input.product) : null,
    ],
    ["api.cart", canonicalBytes(cart.value), cart.hits ? canonicalBytes(input.cart) : null],
    [
      "llm.observation",
      encoder.encode(observation.text),
      observation.hits ? encoder.encode(input.llmObservation) : null,
    ],
    ["dom.snapshot", domBytes(publicDom.dom), publicDom.hits ? domBytes(dom) : null],
    ["ax.tree", axBytes(publicAx.ax), publicAx.hits ? axBytes(axTree) : null],
    ["hidden.text", canonicalBytes(findings), null],
    ["screenshot", covered ?? png, covered ? png : null],
    [
      "mhtml",
      encoder.encode(publicMhtml.hits ? normalizeMhtml(publicMhtml.mhtml) : page),
      publicMhtml.hits ? encoder.encode(page) : null,
    ],
    ["har", canonicalBytes(publicHar.har), publicHar.hits ? canonicalBytes(har) : null],
  ];

  mark = performance.now();
  const encrypter = new Encrypter();
  encrypter.addRecipient(input.recipient);
  const originals = await Promise.all(
    rows.map(([, , original]) => (original ? encrypter.encrypt(original) : null)),
  );
  timings.age = performance.now() - mark;

  mark = performance.now();
  const salt = () => crypto.getRandomValues(new Uint8Array(32));
  const items: SealedItem[] = rows.map(([type, bytes], k) => ({
    type,
    mediaType: MEDIA_TYPES[type],
    bytes,
    salt: input.salts?.[k] ?? salt(),
  }));
  for (const [k, [type]] of rows.entries()) {
    const sealed = originals[k];
    if (sealed)
      items.push({
        type: `${type}.original`,
        mediaType: ORIGINAL_MEDIA_TYPE,
        bytes: sealed,
        salt: salt(),
      });
  }
  const manifest = buildManifest(items);
  timings.manifest = performance.now() - mark;
  timings.total = performance.now() - start;
  return { manifest, items, findings, timings };
}
