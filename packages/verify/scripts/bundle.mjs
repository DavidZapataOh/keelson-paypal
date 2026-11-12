// Bundles @keelson-finance/verifier for npm: the workspace's private @keelson/* code is inlined, every
// third-party package stays a dependency at the version the workspace pins.
// Run before publishing: node packages/verify/scripts/bundle.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const pkgPath = `${root}/packages/verify/package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const pins = {};
for (const name of ["alibi", "core", "log", "mandate", "policy", "evidence", "chain"]) {
  const deps =
    JSON.parse(readFileSync(`${root}/packages/${name}/package.json`, "utf8")).dependencies ?? {};
  for (const [dep, version] of Object.entries(deps))
    if (!dep.startsWith("@keelson/")) pins[dep] = version;
}
const catalog = Object.fromEntries(
  [
    ...readFileSync(`${root}/pnpm-workspace.yaml`, "utf8").matchAll(
      /^\s+"?([@\w/.-]+)"?: ([\d.]+)$/gm,
    ),
  ].map((m) => [m[1], m[2]]),
);
const resolved = Object.fromEntries(
  Object.entries(pins).map(([d, v]) => [d, v === "catalog:" ? catalog[d] : v]),
);
const external = Object.keys(resolved).concat(["canonicalize"]);
for (const entry of ["index", "cli"]) {
  await build({
    entryPoints: [`${root}/packages/verify/src/${entry}.ts`],
    outfile: `${root}/packages/verify/dist/${entry}.js`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    external: external.flatMap((d) => [d, `${d}/*`]),
  });
}
pkg.dependencies = { canonicalize: "5.1.0", ...resolved };
delete pkg.dependencies["@keelson/alibi"];
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("bundled; dependencies:", Object.keys(pkg.dependencies).join(", "));
