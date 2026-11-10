import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { TERMS, TERMS_HASH } from "../src/index.ts";

test("the terms hash is the SHA-256 of the terms", () => {
  expect(TERMS_HASH).toBe(`sha256:${createHash("sha256").update(TERMS, "utf8").digest("hex")}`);
});
