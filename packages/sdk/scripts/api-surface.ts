// Writes api-surface.json: every public method of the built client, which the Python SDK mirrors.
import { writeFileSync } from "node:fs";

// The built client, not the source: the surface is what ships. Imported by URL so typechecking
// does not need a build first.
const { Keelson } = (await import(
  new URL("../dist/index.js", import.meta.url).href
)) as typeof import("../src/index.ts");

const keelson = new Keelson({ auth: null }) as unknown as Record<string, object>;
const methods = (o: object) =>
  Object.getOwnPropertyNames(Object.getPrototypeOf(o)).filter((n) => n !== "constructor");
const surface = [
  ...methods(keelson),
  ...Object.keys(keelson).flatMap((name) => {
    const value = keelson[name];
    return value && typeof value === "object" && value.constructor !== Object
      ? methods(value).map((m) => `${name}.${m}`)
      : [];
  }),
].sort();
writeFileSync(
  new URL("../api-surface.json", import.meta.url),
  `${JSON.stringify(surface, null, 2)}\n`,
);
