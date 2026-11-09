import { pointers, valueAt } from "@keelson/alibi/verify";

export interface Preset {
  id: "raise-cap" | "change-total" | "flip-decision" | "fake-anchor";
  label: string;
  /** The pointer the preset edits in an expanded Alibi, if it has one. */
  pointer: (e: unknown) => string | undefined;
  value: (old: unknown) => unknown;
}

const HEX = "0123456789abcdef";
const rotateHex = (s: unknown) => {
  const t = String(s);
  const last = t.at(-1) ?? "0";
  return t.slice(0, -1) + (HEX[(HEX.indexOf(last.toLowerCase()) + 1) % 16] ?? "0");
};
const bump = (v: unknown) =>
  typeof v === "number" ? v * 10 : typeof v === "string" ? String(BigInt(v) * 10n) : v;

const first = (e: unknown, test: (p: string) => boolean) => pointers(e).find(test);

export const PRESETS: Preset[] = [
  {
    id: "raise-cap",
    label: "Raise the spending cap",
    pointer: (e) =>
      first(
        e,
        (p) =>
          p.startsWith("/mandate/payload_sd/") &&
          /(cap|max|limit|budget)[^/]*$/i.test(p) &&
          /^\d+$/.test(String(valueAt(e, p))),
      ),
    value: bump,
  },
  {
    id: "change-total",
    label: "Change the cart total",
    pointer: (e) =>
      valueAt(e, "/tee/countersign/amount") === undefined ? undefined : "/tee/countersign/amount",
    value: (v) => String(BigInt(String(v)) + 100n),
  },
  {
    id: "flip-decision",
    label: "Flip the decision",
    pointer: (e) => (valueAt(e, "/eval/decision") === undefined ? undefined : "/eval/decision"),
    value: (v) => (v === "deny" ? "allow" : "deny"),
  },
  {
    id: "fake-anchor",
    label: "Fake the on-chain anchor",
    pointer: (e) =>
      valueAt(e, "/anchor/anchored_root") === undefined ? undefined : "/anchor/anchored_root",
    value: rotateHex,
  },
];

/** A copy of `e` with the value at `p` replaced. */
export function setAt(e: unknown, p: string, value: unknown): unknown {
  const copy = structuredClone(e) as Record<string, unknown>;
  const keys = p
    .slice(1)
    .split("/")
    .map((k) => k.replaceAll("~1", "/").replaceAll("~0", "~"));
  let node: Record<string, unknown> = copy;
  for (const k of keys.slice(0, -1)) {
    if (!Object.hasOwn(node, k)) return copy;
    node = node[k] as Record<string, unknown>;
  }
  const last = keys.at(-1) as string;
  if (Object.hasOwn(node, last)) node[last] = value;
  return copy;
}
