// tsc emits no generated declaration file; the built types import it, so it ships beside them.
import { copyFileSync } from "node:fs";

copyFileSync(
  new URL("../src/schema.d.ts", import.meta.url),
  new URL("../dist/schema.d.ts", import.meta.url),
);
