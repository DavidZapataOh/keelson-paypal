import { Buffer } from "node:buffer";
import { Encrypter } from "age-encryption";
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
import {
  fieldEntries,
  PII_FIELDS_SELECTOR,
  redactAx,
  redactDom,
  redactHar,
  redactMhtml,
} from "./redact.ts";

export { buildHar, type Har, type HarEntry, MAX_HAR_BODY } from "./har.ts";
export { normalizeMhtml } from "./mhtml.ts";
export { type RecordedRequest, type Recorder, startRecorder } from "./recorder.ts";
export { PII_FIELDS_SELECTOR } from "./redact.ts";

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

/**
 * The PNG a person may see: the PII form fields and every element whose text holds a known value
 * are painted over in black. `null` when the page shows no PII.
 */
async function maskedScreenshot(
  recorder: Recorder,
  known: readonly PiiEntry[],
): Promise<Uint8Array | null> {
  const { page } = recorder;
  const values = known.filter((e) => e.value.length >= MIN_SUBSTRING_PII).map((e) => e.value);
  const shown = await page.evaluate(
    ([selector, wanted, min]) => {
      const { document } = globalThis as unknown as {
        document: {
          querySelectorAll(s: string): Iterable<{ value: string }>;
          body: { innerText: string };
        };
      };
      const fields = [...document.querySelectorAll(selector)]
        .map((f) => f.value)
        .filter((v) => v.trim().length > 0);
      // biome-ignore lint/performance/useDomNodeTextContent: only rendered text needs a mask
      const text = document.body.innerText.toLowerCase();
      return {
        fields,
        texts: [...wanted, ...fields].filter(
          (v) => v.trim().length >= min && text.includes(v.toLowerCase()),
        ),
      };
    },
    [PII_FIELDS_SELECTOR, values, MIN_SUBSTRING_PII] as const,
  );
  if (shown.fields.length === 0 && shown.texts.length === 0) return null;
  const mask = [
    page.locator(PII_FIELDS_SELECTOR),
    ...[...new Set(shown.texts)].map((v) => page.getByText(v)),
  ];
  const png = await page.screenshot({
    mask,
    maskColor: "#000000",
    animations: "disabled",
    caret: "hide",
  });
  return Uint8Array.from(png);
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

  const [screenshot, masked, snapshot, ax, mhtml] = await Promise.all([
    timed(timings, "screenshot", () => session.send("Page.captureScreenshot", { format: "png" })),
    timed(timings, "maskedScreenshot", () => maskedScreenshot(recorder, known)),
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
    ["screenshot", masked ?? png, masked ? png : null],
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
