import { readdirSync, readFileSync, statSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const vendor = new URL("../vendor/", import.meta.url);

function* files(dir: URL): Generator<URL> {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) yield* files(new URL(`${name}/`, dir));
    else if (name.endsWith(".json")) yield url;
  }
}

/**
 * Every vendored JSON Schema, by `$id`, under JSON Schema 2020-12 with formats. Strict mode is off:
 * the standards annotate their schemas with keywords of their own (`x-selectively-disclosable-array`,
 * `ucp_request`).
 */
export const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);
for (const project of ["ap2", "ucp", "acp"]) {
  for (const url of files(new URL(`${project}/`, vendor))) {
    const schema = JSON.parse(readFileSync(url, "utf8")) as { $id?: string; $schema?: string };
    if (schema.$schema && schema.$id) ajv.addSchema(schema);
  }
}
// AP2's receipt status schema declares `$id` `…/schemas/receipt-status.json`; the receipt schemas
// refer to it as `types/receipt_status.json`.
const { $id: _, ...status } = JSON.parse(
  readFileSync(new URL("ap2/ap2/types/receipt_status.json", vendor), "utf8"),
) as Record<string, unknown>;
ajv.addSchema(status, "https://ap2-protocol.org/schemas/types/receipt_status.json");

/** The validation errors of `data` against the schema `id`, empty when valid. */
export function errors(id: string, data: unknown): string[] {
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`no schema ${id}`);
  return validate(data) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}
