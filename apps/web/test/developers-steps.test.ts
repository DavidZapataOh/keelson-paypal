import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { STEPS } from "../components/developers/steps";

const docs = (page: string) =>
  readFileSync(new URL(`../../docs/src/content/docs/sdk/${page}.mdoc`, import.meta.url), "utf8");

/** The shell commands of a docs page's code blocks, without comments or expected output. */
const commands = (page: string) =>
  [...docs(page).matchAll(/```sh[^\n]*\n([\s\S]*?)```/g)]
    .flatMap((m) => (m[1] as string).split("\n"))
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

describe("the developers page's commands are the ones the docs show", () => {
  test("it installs the published packages", () => {
    const install = STEPS.find((s) => s.id === "install")?.code;
    expect(install).toEqual({
      typescript: "npm install @keelson-finance/sdk @keelson-finance/verifier",
      python: "pip install keelson-finance",
    });
  });

  test.each([
    ["install", "install"],
    ["login", "authentication"],
  ] as const)("%s, as on /sdk/%s", (id, page) => {
    const step = STEPS.find((s) => s.id === id);
    const documented = commands(page).concat(commands("install"));
    for (const code of Object.values(step?.code ?? {})) {
      for (const line of code.split("\n").filter(Boolean)) {
        expect(documented, `"${line}" is not on docs.keelson.finance/sdk/${page}`).toContain(line);
      }
    }
  });
});
