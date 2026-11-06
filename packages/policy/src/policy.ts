import {
  type PolicyJson,
  policySetTextToParts,
  policyToJson,
  preparsePolicySet,
  preparseSchema,
} from "@cedar-policy/cedar-wasm";
import { POLICY_SET_SRC, SCHEMA_SRC } from "./generated/policy.ts";
import { compareStrings } from "./value.ts";

export { POLICY_SET_HASH, SCHEMA_HASH } from "./generated/hashes.ts";
export { POLICY_SET_SRC, SCHEMA_SRC };

/** A policy's text, annotations and effect. */
export interface PolicyInfo {
  readonly id: string | undefined;
  readonly text: string;
  readonly effect: "permit" | "forbid";
  readonly field: string;
  readonly color: string;
}

/** The names the schema and the bundled policy set are preparsed under in Cedar's cache. */
export const SCHEMA_NAME = "keelson";
export const BASE_SET = "keelson";

let cached: ReadonlyMap<string, PolicyInfo> | undefined;

/** The annotations and effect of a policy, from its text and its Cedar JSON form. */
export function policyInfo(text: string, json: PolicyJson): PolicyInfo {
  const a = json.annotations ?? {};
  return { id: a.id, text, effect: json.effect, field: a.field ?? "", color: a.color ?? "" };
}

/**
 * The bundled policies keyed by their `@id` in sorted order. On first use they are passed to
 * Cedar as an id map, so each Cedar policy id is its `@id`, and parsed once into Cedar's cache as
 * [`BASE_SET`], with the schema as [`SCHEMA_NAME`].
 */
export function policies(): ReadonlyMap<string, PolicyInfo> {
  if (cached) return cached;
  const parts = policySetTextToParts(POLICY_SET_SRC);
  if (parts.type !== "success") throw new Error("the bundled policy set parses");
  const entries = parts.policies.map((text) => {
    const json = policyToJson(text);
    const info = json.type === "success" ? policyInfo(text, json.json) : undefined;
    if (info?.id === undefined) throw new Error("every policy has an @id");
    return [info.id, info] as const;
  });
  const map = new Map(entries.sort(([a], [b]) => compareStrings(a, b)));
  if (map.size !== entries.length) throw new Error("@id values are unique");
  const staticPolicies = Object.fromEntries([...map].map(([id, p]) => [id, p.text]));
  if (preparsePolicySet(BASE_SET, { staticPolicies }).type !== "success") {
    throw new Error("the bundled policies parse");
  }
  if (preparseSchema(SCHEMA_NAME, SCHEMA_SRC).type !== "success") {
    throw new Error("the bundled schema parses");
  }
  cached = map;
  return map;
}
