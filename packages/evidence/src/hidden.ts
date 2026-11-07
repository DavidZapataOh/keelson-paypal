import type { AxV1 } from "./ax.ts";
import type { Box, DomNode, DomV1 } from "./dom.ts";

export type HiddenReason =
  | "opacity"
  | "offscreen"
  | "same-color"
  | "tiny"
  | "clipped"
  | "aria-hidden"
  | "attribute"
  | "behind";

/** Text the agent could read and a person looking at the page could not. */
export interface HiddenTextFinding {
  text: string;
  /** The `keelson-dom-v1` node index: the text node, or the element carrying the attribute. */
  node: number;
  reasons: HiddenReason[];
  inAxTree: boolean;
  reachedAgent: boolean;
}

const MIN_OPACITY = 0.1;
const MIN_CONTRAST = 1.2;
const MIN_FONT_PX = 2;
const MIN_AREA_PX2 = 4;
/** Shorter attribute text ("Close", "Open menu") is an ordinary icon label. */
const MIN_ATTRIBUTE_WORDS = 3;
const ATTRIBUTE_SOURCES = ["alt", "title", "aria-label", "aria-description"];

type Rgba = [r: number, g: number, b: number, a: number];

function parseColor(value: string | undefined): Rgba | null {
  const m = /^rgba?\(([^)]+)\)$/.exec(value?.trim() ?? "");
  if (!m) return null;
  const parts = (m[1] as string)
    .split(/[\s,/]+/)
    .filter(Boolean)
    .map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return null;
  return [parts[0] as number, parts[1] as number, parts[2] as number, parts[3] ?? 1];
}

function luminance([r, g, b]: Rgba): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG 2 contrast ratio, with the foreground alpha-blended over the background. */
function contrast(fg: Rgba, bg: Rgba): number {
  const a = fg[3];
  const blended: Rgba = [
    fg[0] * a + bg[0] * (1 - a),
    fg[1] * a + bg[1] * (1 - a),
    fg[2] * a + bg[2] * (1 - a),
    1,
  ];
  const [l1, l2] = [luminance(blended), luminance(bg)].sort((x, y) => y - x) as [number, number];
  return (l1 + 0.05) / (l2 + 0.05);
}

const px = (value: string | undefined): number | null => {
  const m = /^(-?[\d.]+)px$/.exec(value?.trim() ?? "");
  return m ? Number(m[1]) : null;
};

/** The visible area a `clip` or `clip-path` leaves of a box, or `null` when it cannot tell. */
function clippedArea(node: DomNode): number | null {
  const box = node.box;
  const clip = node.style?.clip;
  if (clip?.startsWith("rect(")) {
    const v = clip
      .slice(5, -1)
      .split(/[\s,]+/)
      .map(px);
    if (v.every((x) => x !== null)) {
      const [top, right, bottom, left] = v as [number, number, number, number];
      return Math.max(0, right - left) * Math.max(0, bottom - top);
    }
  }
  const clipPath = node.style?.["clip-path"];
  if (clipPath && box) {
    if (/^(circle|ellipse)\(0(px|%)?\b/.test(clipPath)) return 0;
    const inset = /^inset\(([^)]+)\)/.exec(clipPath)?.[1];
    if (inset) {
      const v = inset.split(/\s+/).slice(0, 4);
      const len = (s: string | undefined, of: number) =>
        s?.endsWith("%") ? (Number(s.slice(0, -1)) / 100) * of : (px(s) ?? 0);
      const [t, r = t, b = t, l = r] = v;
      const w = box[2] - len(l, box[2]) - len(r, box[2]);
      const h = box[3] - len(t, box[3]) - len(b, box[3]);
      return Math.max(0, w) * Math.max(0, h);
    }
  }
  const overflow = node.style?.overflow ?? "";
  if (box && /hidden|clip/.test(overflow)) return box[2] * box[3];
  return null;
}

const contains = (outer: Box, inner: Box) =>
  outer[0] <= inner[0] &&
  outer[1] <= inner[1] &&
  outer[0] + outer[2] >= inner[0] + inner[2] &&
  outer[1] + outer[3] >= inner[1] + inner[3];

/** NFC, collapsed whitespace, case-folded. */
function fold(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

const tidy = (text: string) => text.normalize("NFC").replace(/\s+/g, " ").trim();

/**
 * Finds the text a model reading the DOM or the accessibility tree saw and a person could not:
 * transparent, off-screen, same-colour, tiny, clipped or covered text, and attribute text exposed
 * to assistive technology but never rendered. `reachedAgent` says whether it appears in what the
 * model received.
 */
export function detectHiddenText(
  dom: DomV1,
  ax: AxV1,
  llmObservation: string,
): HiddenTextFinding[] {
  const nodes = dom.nodes;
  const ancestors = (n: DomNode): DomNode[] => {
    const out: DomNode[] = [];
    for (let p = n.p; p !== null; p = nodes[p]?.p ?? null) {
      const parent = nodes[p];
      if (!parent) break;
      out.push(parent);
    }
    return out;
  };
  const axText = ax.nodes.flatMap((n) =>
    [n.name, n.description, typeof n.value === "string" ? n.value : undefined]
      .filter((s): s is string => !!s)
      .map(fold),
  );
  const inAx = (text: string) => {
    const t = fold(text);
    return axText.some((s) => s.includes(t));
  };
  const observation = fold(llmObservation);
  const opaque = nodes.filter(
    (n) =>
      n.tag &&
      n.box &&
      n.paint !== undefined &&
      parseColor(n.style?.["background-color"])?.[3] === 1,
  );

  const findings: HiddenTextFinding[] = [];
  const visible: string[] = [];
  for (const t of nodes) {
    if (t.text === undefined || !t.box) continue;
    const chain = ancestors(t);
    const el = chain[0];
    if (!el) continue;
    const reasons = new Set<HiddenReason>();
    if ((el.textOpacity ?? 1) < MIN_OPACITY) reasons.add("opacity");

    const [x, y, w, h] = t.box;
    if (x + w <= 0 || y + h <= 0 || x >= dom.content.w || y >= dom.content.h)
      reasons.add("offscreen");

    const fg = parseColor(el.style?.color ?? "rgb(0, 0, 0)");
    const bgSource = chain.find((a) => a.bg)?.bg ?? "rgb(255, 255, 255)";
    const bg = parseColor(bgSource);
    if (fg && bg && contrast(fg, bg) < MIN_CONTRAST) reasons.add("same-color");

    const size = px(el.style?.["font-size"] ?? "16px");
    if (size !== null && size < MIN_FONT_PX) reasons.add("tiny");

    for (const a of chain) {
      const area = clippedArea(a);
      if (area !== null && area < MIN_AREA_PX2) reasons.add("clipped");
    }

    if (t.paint !== undefined) {
      const ids = new Set(chain.map((a) => a.i));
      const cover = opaque.find(
        (o) =>
          (o.paint as number) > (t.paint as number) &&
          !ids.has(o.i) &&
          contains(o.box as Box, t.box as Box),
      );
      if (cover) reasons.add("behind");
    }

    if (reasons.size === 0) {
      visible.push(t.text);
      continue;
    }
    if (chain.some((a) => a.attrs?.some(([k, v]) => k === "aria-hidden" && v === "true")))
      reasons.add("aria-hidden");
    findings.push({
      text: tidy(t.text),
      node: t.i,
      reasons: [...reasons],
      inAxTree: inAx(t.text),
      reachedAgent: observation.includes(fold(t.text)),
    });
  }

  const rendered = fold(visible.join(" "));
  for (const el of nodes) {
    if (!el.attrs) continue;
    for (const [name, raw] of el.attrs) {
      const fromMeta = el.tag === "meta" && name === "content";
      if (!ATTRIBUTE_SOURCES.includes(name) && !name.startsWith("data-") && !fromMeta) continue;
      const text = tidy(raw);
      if (text.split(" ").length < MIN_ATTRIBUTE_WORDS) continue;
      if (!inAx(text) || rendered.includes(fold(text))) continue;
      // The alt text of an image a person can see stands for what they see.
      const shown =
        el.box && el.box[2] * el.box[3] >= MIN_AREA_PX2 && (el.textOpacity ?? 1) >= MIN_OPACITY;
      if (name === "alt" && el.tag === "img" && shown) continue;
      findings.push({
        text,
        node: el.i,
        reasons: ["attribute"],
        inAxTree: true,
        reachedAgent: observation.includes(fold(text)),
      });
    }
  }
  return findings.sort((a, b) => a.node - b.node);
}
