import { canonicalBytes } from "./canonical.ts";

/** The parts of a CDP `Accessibility.AXNode` the normalizer reads. */
export interface AxNodeInput {
  nodeId: string;
  ignored: boolean;
  ignoredReasons?: { name: string; value: { value?: unknown } }[];
  role?: { value?: unknown };
  name?: { value?: unknown };
  description?: { value?: unknown };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
  parentId?: string;
  childIds?: string[];
}

export interface AxNode {
  i: number;
  p: number | null;
  role?: string;
  name?: string;
  description?: string;
  value?: string | number | boolean;
  props?: [name: string, value: string | number | boolean][];
  ignored?: string[];
}

export interface AxV1 {
  v: "keelson-ax-v1";
  nodes: AxNode[];
}

const scalar = (v: unknown): string | number | boolean | undefined =>
  typeof v === "string"
    ? v.normalize("NFC")
    : typeof v === "number" || typeof v === "boolean"
      ? v
      : undefined;

/**
 * Normalizes `Accessibility.getFullAXTree` to a pre-order list with parent indices. Node, backend
 * and frame ids and child id lists are dropped (they change between captures), and so are
 * `InlineTextBox` nodes, which repeat their parent's text.
 */
export function normalizeAx(input: readonly AxNodeInput[]): AxV1 {
  const byId = new Map(input.map((n) => [n.nodeId, n]));
  const roots = input.filter((n) => n.parentId === undefined || !byId.has(n.parentId));
  const nodes: AxNode[] = [];
  const visit = (n: AxNodeInput, parent: number | null): void => {
    if (n.role?.value === "InlineTextBox") return;
    const out: AxNode = { i: nodes.length, p: parent };
    const role = scalar(n.role?.value);
    if (typeof role === "string" && role !== "") out.role = role;
    const name = scalar(n.name?.value);
    if (typeof name === "string" && name !== "") out.name = name;
    const description = scalar(n.description?.value);
    if (typeof description === "string" && description !== "") out.description = description;
    const value = scalar(n.value?.value);
    if (value !== undefined && value !== "") out.value = value;
    const props = (n.properties ?? [])
      .map((p) => [p.name, scalar(p.value.value)] as const)
      .filter((p): p is [string, string | number | boolean] => p[1] !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    if (props.length > 0) out.props = props;
    if (n.ignored) out.ignored = (n.ignoredReasons ?? []).map((r) => r.name).sort();
    nodes.push(out);
    for (const id of n.childIds ?? []) {
      const child = byId.get(id);
      if (child) visit(child, out.i);
    }
  };
  for (const root of roots) visit(root, null);
  return { v: "keelson-ax-v1", nodes };
}

export function axBytes(ax: AxV1): Uint8Array {
  return canonicalBytes(ax);
}
