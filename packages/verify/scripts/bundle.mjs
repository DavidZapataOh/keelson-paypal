// Bundles @keelson-finance/verifier for npm: the workspace's private @keelson/* code is inlined, every
// third-party package stays a dependency at the version the workspace pins.
// Run before publishing: node packages/verify/scripts/bundle.mjs
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const pkgPath = `${root}/packages/verify/package.json`;
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
// Every third-party package the verifier's private @keelson/* code needs, all the way down.
const dirs = Object.fromEntries(
  readdirSync(`${root}/packages`, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(`${root}/packages/${d.name}/package.json`))
    .map((d) => [
      JSON.parse(readFileSync(`${root}/packages/${d.name}/package.json`, "utf8")).name,
      d.name,
    ]),
);
const pins = {};
const seen = new Set();
const queue = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@keelson/"));
while (queue.length) {
  const name = queue.shift();
  if (seen.has(name)) continue;
  seen.add(name);
  const deps =
    JSON.parse(readFileSync(`${root}/packages/${dirs[name]}/package.json`, "utf8")).dependencies ??
    {};
  for (const [dep, version] of Object.entries(deps)) {
    if (dep.startsWith("@keelson/")) queue.push(dep);
    else pins[dep] = version;
  }
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
    // CommonJS code inlined into this ES module still calls require() for Node's built-ins.
    banner: {
      js: 'import { createRequire as __keelsonRequire } from "node:module";\nconst require = __keelsonRequire(import.meta.url);',
    },
  });
}
pkg.dependencies = Object.fromEntries(
  Object.entries({ canonicalize: "5.1.0", ...resolved }).filter(
    ([d]) => !d.startsWith("@keelson/"),
  ),
);
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log("bundled; dependencies:", Object.keys(pkg.dependencies).join(", "));
