import { expect, test } from "vitest";
import { ASSISTANT_LIMITS } from "../src/routes/merchant-assistant.ts";
import { GRID_LIMITS } from "../src/routes/operator-console.ts";

/** The API's handler timeout (`createApp`'s `requestTimeoutMs` default). */
const HANDLER_MS = 30_000;
const worst = (l: { timeout: number; maxRetries: number }) => l.timeout * (l.maxRetries + 1);

test("a grid query's model call ends, retries included, before its handler does", () => {
  expect(worst(GRID_LIMITS)).toBeLessThan(HANDLER_MS);
});

test("an assistant turn has its first byte, retries included, before its handler times out", () => {
  expect(worst(ASSISTANT_LIMITS)).toBeLessThan(HANDLER_MS);
});
