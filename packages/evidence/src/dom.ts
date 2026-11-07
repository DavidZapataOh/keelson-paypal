import { canonicalBytes } from "./canonical.ts";

/** The computed styles a DOM snapshot requests, in this order. */
export const COMPUTED_STYLES = [
  "display",
  "visibility",
  "opacity",
  "color",
  "background-color",
  "font-size",
  "position",
  "clip",
  "clip-path",
  "transform",
  "overflow",
  "z-index",
  "text-indent",
  "width",
  "height",
] as const;

export type ComputedStyleName = (typeof COMPUTED_STYLES)[number];

/** CSS initial values; a computed style equal to its initial value is left out. */
const INITIAL: Readonly<Record<ComputedStyleName, string>> = {
  display: "inline",
  visibility: "visible",
  opacity: "1",
  color: "rgb(0, 0, 0)",
  "background-color": "rgba(0, 0, 0, 0)",
  "font-size": "16px",
  position: "static",
  clip: "auto",
  "clip-path": "none",
  transform: "none",
  overflow: "visible",
  "z-index": "auto",
  "text-indent": "0px",
  width: "auto",
  height: "auto",
};

/** The parts of a CDP `DOMSnapshot.captureSnapshot` result the normalizer reads. */
export interface DomSnapshot {
  documents: {
    documentURL: number;
    contentWidth?: number;
    contentHeight?: number;
    nodes: {
      parentIndex?: number[];
      nodeType?: number[];
      nodeName?: number[];
      nodeValue?: number[];
      attributes?: number[][];
      inputValue?: { index: number[]; value: number[] };
      textValue?: { index: number[]; value: number[] };
      pseudoType?: { index: number[]; value: number[] };
    };
    layout: {
      nodeIndex: number[];
      styles: number[][];
      bounds: number[][];
      paintOrders?: number[];
      blendedBackgroundColors?: number[];
      textColorOpacities?: number[];
    };
  }[];
  strings: string[];
}

export type Box = [x: number, y: number, w: number, h: number];

export interface DomNode {
  /** Pre-order index. */
  i: number;
  /** Parent index; `null` for the root element. */
  p: number | null;
  tag?: string;
  text?: string;
  /** The current value of an `input` or `textarea`. */
  value?: string;
  attrs?: [name: string, value: string][];
  box?: Box;
  style?: Partial<Record<ComputedStyleName, string>>;
  textOpacity?: number;
  bg?: string;
  paint?: number;
}

export interface DomV1 {
  v: "keelson-dom-v1";
  url: string;
  viewport: { w: number; h: number };
  /** The scrollable document area. */
  content: { w: number; h: number };
  nodes: DomNode[];
}

const ELEMENT = 1;
const TEXT = 3;
const DROPPED_TAGS = new Set(["script", "style", "noscript", "template"]);
/** Attributes that differ between loads of the same page. */
const VOLATILE_ATTRS = new Set(["nonce", "integrity"]);
const URL_ATTRS = new Set(["href", "src", "action", "formaction", "poster"]);

function rare(data: { index: number[]; value: number[] } | undefined): Map<number, number> {
  const out = new Map<number, number>();
  if (!data) return out;
  data.index.forEach((node, k) => {
    out.set(node, data.value[k] as number);
  });
  return out;
}

function resolve(value: string, base: string): string {
  try {
    return new URL(value, base).href;
  } catch {
    return value;
  }
}

/**
 * Normalizes the main document of a DOM snapshot to `keelson-dom-v1`: a pre-order list of
 * elements and text, without scripts, styles, comments, whitespace-only text or backend ids,
 * so that two captures of the same rendering give the same bytes.
 */
export function normalizeDom(snapshot: DomSnapshot, opts: { baseUrl: string }): DomV1 {
  const doc = snapshot.documents[0];
  if (!doc) throw new TypeError("the snapshot has no document");
  const s = (k: number | undefined) =>
    k === undefined || k < 0 ? "" : (snapshot.strings[k] ?? "");
  const n = doc.nodes;
  const parents = n.parentIndex ?? [];
  const count = parents.length;
  const children: number[][] = Array.from({ length: count }, () => []);
  for (let k = 0; k < count; k++) {
    const p = parents[k] as number;
    if (p >= 0) children[p]?.push(k);
  }

  const layoutOf = new Map<number, number>();
  doc.layout.nodeIndex.forEach((node, l) => {
    if (!layoutOf.has(node)) layoutOf.set(node, l);
  });
  const inputs = rare(n.inputValue);
  const textareas = rare(n.textValue);
  const pseudo = rare(n.pseudoType);

  const nodes: DomNode[] = [];
  const visit = (k: number, parent: number | null): void => {
    const type = n.nodeType?.[k];
    let out: DomNode | undefined;
    if (type === ELEMENT) {
      const pseudoType = pseudo.get(k);
      const tag =
        pseudoType === undefined ? s(n.nodeName?.[k]).toLowerCase() : `::${s(pseudoType)}`;
      if (DROPPED_TAGS.has(tag)) return;
      out = { i: nodes.length, p: parent, tag };
      const raw = n.attributes?.[k] ?? [];
      const attrs: [string, string][] = [];
      for (let a = 0; a + 1 < raw.length; a += 2) {
        const name = s(raw[a]);
        if (VOLATILE_ATTRS.has(name)) continue;
        const value = s(raw[a + 1]).normalize("NFC");
        attrs.push([name, URL_ATTRS.has(name) ? resolve(value, opts.baseUrl) : value]);
      }
      attrs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (attrs.length > 0) out.attrs = attrs;
      const value = inputs.get(k) ?? textareas.get(k);
      if (value !== undefined && value >= 0) out.value = s(value).normalize("NFC");
    } else if (type === TEXT) {
      const text = s(n.nodeValue?.[k]);
      if (text.trim() === "") return;
      out = { i: nodes.length, p: parent, text: text.normalize("NFC") };
    }
    if (out) {
      const l = layoutOf.get(k);
      if (l !== undefined) layout(out, l, type === ELEMENT);
      nodes.push(out);
    }
    const next = out ? out.i : parent;
    for (const c of children[k] ?? []) visit(c, next);
  };

  const layout = (out: DomNode, l: number, element: boolean): void => {
    const b = doc.layout.bounds[l];
    if (b && b.length === 4) out.box = b.map((v) => Math.round(v)) as Box;
    if (element) {
      const style: Partial<Record<ComputedStyleName, string>> = {};
      for (const [j, k] of (doc.layout.styles[l] ?? []).entries()) {
        const name = COMPUTED_STYLES[j];
        const value = s(k);
        if (name && value !== "" && value !== INITIAL[name]) style[name] = value;
      }
      if (Object.keys(style).length > 0) out.style = style;
      const opacity = doc.layout.textColorOpacities?.[l];
      if (opacity !== undefined && opacity !== 1) out.textOpacity = opacity;
      const bg = s(doc.layout.blendedBackgroundColors?.[l]);
      if (bg !== "") out.bg = bg;
    }
    const paint = doc.layout.paintOrders?.[l];
    if (paint !== undefined) out.paint = paint;
  };

  for (const k of children[0] ?? []) visit(k, null);

  const root = layoutOf.get(0);
  const vb = root === undefined ? undefined : doc.layout.bounds[root];
  const viewport = { w: Math.round(vb?.[2] ?? 0), h: Math.round(vb?.[3] ?? 0) };
  return {
    v: "keelson-dom-v1",
    url: s(doc.documentURL),
    viewport,
    content: {
      w: Math.round(doc.contentWidth ?? viewport.w),
      h: Math.round(doc.contentHeight ?? viewport.h),
    },
    nodes,
  };
}

/** The item bytes: UTF-8 RFC 8785 JSON. */
export function domBytes(d: DomV1): Uint8Array {
  return canonicalBytes(d);
}
