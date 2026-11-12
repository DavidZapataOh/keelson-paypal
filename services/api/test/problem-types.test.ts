import { execFileSync } from "node:child_process";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { PROBLEM_TYPES } from "../src/problem-types.ts";
import { testDb, testKv } from "./setup.ts";

const app = createApp({ db: testDb, kv: testKv, log: pino({ level: "silent" }) });

describe("problem types (RFC 9457 §3.1.1)", () => {
  test("every type the API can return has a page at its URL", async () => {
    for (const slug of Object.keys(PROBLEM_TYPES)) {
      const res = await app.request(`/problems/${slug}`);
      expect(res.status, slug).toBe(200);
      expect(res.headers.get("content-type"), slug).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
      const html = await res.text();
      expect(html).toContain(`<code>type: https://api.keelson.finance/problems/${slug}</code>`);
    }
  });

  test("an unknown type is a not-found problem", async () => {
    const res = await app.request("/problems/no-such-problem");
    expect(res.status).toBe(404);
    expect((await res.json()).type).toBe("https://api.keelson.finance/problems/not-found");
  });

  test("every slug written at a call site is in the registry", () => {
    const out = execFileSync(
      "git",
      ["grep", "-hoP", String.raw`problem\(\s*c\w*,\s*[^,]+,\s*"\K[a-z0-9-]+(?=")`, "--", "src"],
      { cwd: new URL("..", import.meta.url).pathname, encoding: "utf8" },
    );
    const used = new Set(out.split("\n").filter(Boolean));
    expect([...used].filter((s) => !(s in PROBLEM_TYPES))).toEqual([]);
  });
});
