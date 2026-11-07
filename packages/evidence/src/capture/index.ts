import { Buffer } from "node:buffer";
import { axBytes, normalizeAx } from "../ax.ts";
import { canonicalBytes } from "../canonical.ts";
import { COMPUTED_STYLES, type DomSnapshot, domBytes, normalizeDom } from "../dom.ts";
import { detectHiddenText, type HiddenTextFinding } from "../hidden.ts";
import { type ItemType, MEDIA_TYPES, type SealedItem } from "../items.ts";
import { buildManifest, type Manifest } from "../manifest.ts";
import { buildHar } from "./har.ts";
import { normalizeMhtml } from "./mhtml.ts";
import type { Recorder } from "./recorder.ts";

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
  /** Pins the item salts, in item order; only for tests. */
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
 * Captures what the agent saw at decision time through the recorder's CDP session and seals it
 * into a salted manifest whose root is the `evidenceRoot`.
 */
export async function captureEvidence(recorder: Recorder, input: CaptureInput): Promise<Capture> {
  const timings: Record<string, number> = {};
  const start = performance.now();
  const { session } = recorder;

  const [screenshot, snapshot, ax, mhtml] = await Promise.all([
    timed(timings, "screenshot", () => session.send("Page.captureScreenshot", { format: "png" })),
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

  const normalizeStart = performance.now();
  const dom = normalizeDom(snapshot as DomSnapshot, { baseUrl: recorder.page.url() });
  const axTree = normalizeAx(ax.nodes);
  const har = buildHar(recorder.requests);
  timings.normalize = performance.now() - normalizeStart;

  const detectorStart = performance.now();
  const findings = detectHiddenText(dom, axTree, input.llmObservation);
  timings.detector = performance.now() - detectorStart;

  const publicBytes: [ItemType, Uint8Array][] = [
    ["api.product", canonicalBytes(input.product)],
    ["api.cart", canonicalBytes(input.cart)],
    ["llm.observation", encoder.encode(input.llmObservation)],
    ["dom.snapshot", domBytes(dom)],
    ["ax.tree", axBytes(axTree)],
    ["hidden.text", canonicalBytes(findings)],
    ["screenshot", Uint8Array.from(Buffer.from(screenshot.data, "base64"))],
    ["mhtml", encoder.encode(normalizeMhtml(mhtml.data))],
    ["har", canonicalBytes(har)],
  ];

  const manifestStart = performance.now();
  const items: SealedItem[] = publicBytes.map(([type, bytes], k) => ({
    type,
    mediaType: MEDIA_TYPES[type],
    bytes,
    salt: input.salts?.[k] ?? crypto.getRandomValues(new Uint8Array(32)),
  }));
  const manifest = buildManifest(items);
  timings.manifest = performance.now() - manifestStart;
  timings.total = performance.now() - start;
  return { manifest, items, findings, timings };
}
