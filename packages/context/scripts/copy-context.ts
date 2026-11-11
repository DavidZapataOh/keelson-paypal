// Copies what the plugin answers from into `context/`, shipped with the package: the OpenAPI
// document, and the README and examples of each SDK.
import { cpSync, mkdirSync, rmSync } from "node:fs";

const root = new URL("../../../", import.meta.url);
const out = new URL("../context/", import.meta.url);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(new URL("openapi/keelson.yaml", root), new URL("keelson.yaml", out));
for (const [from, to] of [
  ["packages/sdk/", "typescript/"],
  ["packages/sdk-python/", "python/"],
]) {
  cpSync(new URL(`${from}README.md`, root), new URL(`${to}README.md`, out));
  cpSync(new URL(`${from}examples/`, root), new URL(`${to}examples/`, out), { recursive: true });
}
