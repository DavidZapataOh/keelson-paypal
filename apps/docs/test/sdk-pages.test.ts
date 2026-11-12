import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { fences, REPO } from "./lib/markdown";

const read = (path: string) => readFileSync(join(REPO, path), "utf8");
const PAGES = ["install", "authentication", "mandates", "purchases", "verify"];
const page = (name: string) => read(`apps/docs/src/content/docs/sdk/${name}.mdoc`);

const surface = new Set(JSON.parse(read("packages/sdk/api-surface.json")) as string[]);
const tsExports = read("packages/sdk/src/index.ts") + read("packages/sdk/src/errors.ts");
const verifier = read("packages/verify/src/index.ts");
const pyMethods = new Set(
  readdirSync(join(REPO, "packages/sdk-python/src/keelson/resources"))
    .filter((f) => f.endsWith(".py"))
    .flatMap((f) =>
      [...read(`packages/sdk-python/src/keelson/resources/${f}`).matchAll(/def ([a-z_]+)\(/g)].map(
        (m) => m[1] as string,
      ),
    ),
);
const pyExports = read("packages/sdk-python/src/keelson/__init__.py");

describe("the SDK pages call only what the SDKs have", () => {
  for (const name of PAGES) {
    const code = fences(page(name));
    const ts = code
      .filter((f) => f.lang === "ts")
      .map((f) => f.body)
      .join("\n");
    const py = code
      .filter((f) => f.lang === "python")
      .map((f) => f.body)
      .join("\n");

    test(`${name}: every TypeScript call and import exists`, () => {
      for (const [, call] of ts.matchAll(/keelson\.([a-z]+\.[a-zA-Z]+)\(/g)) {
        expect(surface.has(call as string), call).toBe(true);
      }
      for (const [, names, from] of ts.matchAll(/import \{([^}]+)\} from "([^"]+)"/g)) {
        const adapter = /^@keelson-finance\/sdk\/([a-z-]+)$/.exec(from as string)?.[1];
        const source =
          from === "@keelson-finance/verifier"
            ? verifier
            : adapter
              ? read(`packages/sdk/src/adapters/${adapter}.ts`)
              : tsExports;
        for (const n of (names as string).split(",").map((s) => s.trim())) {
          expect(source, `${n} from ${from}`).toMatch(new RegExp(`\\b${n}\\b`));
        }
      }
    });

    test(`${name}: every Python call and import exists`, () => {
      for (const [, method] of py.matchAll(/keelson\.[a-z]+\.([a-z_]+)\(/g)) {
        expect(pyMethods.has(method as string), method).toBe(true);
      }
      for (const [, mod, name] of py.matchAll(
        /from keelson\.adapters\.([a-z_]+) import ([a-z_]+)/g,
      )) {
        expect(read(`packages/sdk-python/src/keelson/adapters/${mod}.py`)).toContain(
          `def ${name}(`,
        );
      }
      for (const [, names] of py.matchAll(/from keelson import ([^\n]+)/g)) {
        for (const n of (names as string).split(",").map((s) => s.trim())) {
          expect(pyExports, n).toContain(`"${n}"`);
        }
      }
    });
  }

  test("install says the packages are not on a registry yet, and installs from the repository", () => {
    const install = page("install");
    expect(read("packages/sdk/package.json")).toContain('"name": "@keelson-finance/sdk"');
    expect(read("packages/verify/package.json")).toContain('"name": "@keelson-finance/verifier"');
    expect(read("packages/sdk-python/pyproject.toml")).toContain('name = "keelson-finance"');
    expect(install).toContain("not on npm or PyPI yet");
    expect(install).not.toMatch(/^(npm install|pip install) /m);
  });

  test("authentication lists the environment variables the clients read", () => {
    const client = read("packages/sdk/src/client.ts");
    for (const v of [
      "KEELSON_CLIENT_ID",
      "KEELSON_CLIENT_SECRET",
      "KEELSON_TOKEN",
      "KEELSON_AGENT_KEY",
      "KEELSON_API_URL",
    ]) {
      expect(page("authentication"), v).toContain(v);
      expect(client + read("packages/sdk/src/credentials.ts"), v).toContain(v);
    }
    for (const scope of ["mandates:request", "evidence:write", "purchases:write", "alibis:read"]) {
      expect(read("packages/sdk/src/login.ts")).toContain(`"${scope}"`);
      expect(page("authentication")).toContain(scope);
    }
  });

  test("verify documents the verifier's options and exit codes", () => {
    const cli = read("packages/verify/src/cli.ts");
    expect(cli).toContain("Exits 0 when verified, 1 when it fails, 2 when\nincomplete.");
    expect(verifier).toContain("chain?: boolean | { rpcUrl: string };");
    expect(read("packages/sdk-python/src/keelson/_verify.py")).toContain("KEELSON_VERIFY_COMMAND");
    for (const s of ["--chain", "--rpc", "--json", "KEELSON_VERIFY_COMMAND", "rpcUrl"]) {
      expect(page("verify"), s).toContain(s);
    }
  });
});
