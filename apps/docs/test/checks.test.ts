import { describe, expect, test } from "vitest";
import { allChecks, extractChecks } from "./lib/checks";

const MDOC = [
  "Intro.",
  "",
  '```sh {% check="first" %}',
  "echo one",
  "# expect: ^one$",
  "```",
  "",
  "```sh",
  "echo not a check",
  "```",
  "",
  '```sh {% check="second" %}',
  "echo two",
  "# expect: two",
  "```",
  "",
].join("\n");

describe("extractChecks", () => {
  test("turns each check block into a Check with its id, line and expectation", () => {
    const checks = extractChecks(MDOC, "page.mdoc");
    expect(checks.map((c) => [c.id, c.line, c.expect.source, c.script])).toEqual([
      ["first", 3, "^one$", "echo one"],
      ["second", 12, "two", "echo two"],
    ]);
  });

  test("reads GitHub Markdown's info string form", () => {
    const md = "```sh check=readme-one\necho hi\n# expect: hi\n```\n";
    expect(extractChecks(md, "README.md").map((c) => c.id)).toEqual(["readme-one"]);
  });

  test("throws when a check has no expectation", () => {
    const md = '```sh {% check="lonely" %}\necho hi\n```\n';
    expect(() => extractChecks(md, "page.mdoc")).toThrow("missing expect at page.mdoc:1");
  });

  test("ignores plain shell blocks", () => {
    expect(extractChecks("```sh\necho hi\n# expect: hi\n```\n", "page.mdoc")).toEqual([]);
  });

  test("reads a check next to other fence attributes", () => {
    const md = '```sh {% file="verify.sh" check="both" %}\necho hi\n# expect: hi\n```\n';
    expect(extractChecks(md, "page.mdoc").map((c) => c.id)).toEqual(["both"]);
  });

  test("the quickstart's one command is a check", () => {
    expect(allChecks().map((c) => c.id)).toContain("verify-one-command");
  });

  test("no check depends on the docs site it documents", () => {
    const circular = allChecks()
      .filter((c) => c.script.includes("docs.keelson.finance"))
      .map((c) => c.id);
    expect(circular).toEqual([]);
  });

  test("ids are unique across every documentation file", () => {
    const ids = allChecks().map((c) => c.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});
