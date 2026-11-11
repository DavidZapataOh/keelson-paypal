import { readdirSync, readFileSync, statSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const root = new URL("../vendor/", import.meta.url);

function* files(dir: URL): Generator<URL> {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) yield* files(new URL(`${name}/`, dir));
    else if (name.endsWith(".json")) yield url;
  }
}

/**
 * Every vendored schema, compiled by its `$id` with JSON Schema 2020-12 and the formats the
 * schemas name. Strict mode is off: the projects annotate their schemas with keywords of their
 * own (`ucp_request`, `x-selectively-disclosable-array`, `name`).
 */
export const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
for (const url of files(root)) ajv.addSchema(JSON.parse(readFileSync(url, "utf8")));
// AP2 v0.2.0's receipt status schema declares `$id` `…/schemas/receipt-status.json`, while the
// receipt schemas refer to it as `types/receipt_status.json`: register it under that name too.
const { $id: _, ...receiptStatus } = JSON.parse(
  readFileSync(new URL("ap2/ap2/types/receipt_status.json", root), "utf8"),
) as Record<string, unknown>;
ajv.addSchema(receiptStatus, "https://ap2-protocol.org/schemas/types/receipt_status.json");

/** Validates `data` against the schema `id` (with an optional JSON pointer), returning errors. */
export function errors(id: string, data: unknown): string[] {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`no schema ${id}`);
  return validate(data) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
