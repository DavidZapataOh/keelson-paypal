import { expect, test } from "vitest";
import { parseEnv } from "../src/env.ts";

const base = {
  DATABASE_URL: "postgres://localhost/keelson",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "s".repeat(32),
};

test("production requires an https auth URL", () => {
  expect(() =>
    parseEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "http://api.keelson.finance" }),
  ).toThrow();
  expect(
    parseEnv({ ...base, NODE_ENV: "production", BETTER_AUTH_URL: "https://api.keelson.finance" })
      .BETTER_AUTH_URL,
  ).toBe("https://api.keelson.finance");
});

test("development accepts an http auth URL", () => {
  expect(parseEnv({ ...base, BETTER_AUTH_URL: "http://localhost:10000" }).NODE_ENV).toBe(
    "development",
  );
});
