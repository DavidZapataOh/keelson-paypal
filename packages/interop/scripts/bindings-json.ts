/** Writes `bindings.json`: the export binding table, for the enclave issuer. */
import { writeFileSync } from "node:fs";
import { EXPORT_BINDINGS } from "../src/bindings.ts";

writeFileSync(
  new URL("../bindings.json", import.meta.url),
  `${JSON.stringify(
    Object.entries(EXPORT_BINDINGS).map(([profile, { typ, rows }]) => ({ profile, typ, rows })),
    null,
    2,
  )}\n`,
);
