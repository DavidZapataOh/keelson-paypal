import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  POLICY_SET_HASH as LIGHT_POLICY_SET_HASH,
  SCHEMA_HASH as LIGHT_SCHEMA_HASH,
} from "../src/generated/hashes.ts";
import { POLICY_SET_HASH, POLICY_SET_SRC, SCHEMA_HASH, SCHEMA_SRC } from "../src/index.ts";

const sha256 = (s: string) => `sha256:${createHash("sha256").update(s, "utf8").digest("hex")}`;

describe("the hashes export", () => {
  it("hashes the embedded sources", () => {
    expect(LIGHT_POLICY_SET_HASH).toBe(sha256(POLICY_SET_SRC));
    expect(LIGHT_SCHEMA_HASH).toBe(sha256(SCHEMA_SRC));
  });

  it("is what the evaluator records", () => {
    expect(POLICY_SET_HASH).toBe(LIGHT_POLICY_SET_HASH);
    expect(SCHEMA_HASH).toBe(LIGHT_SCHEMA_HASH);
  });
});
