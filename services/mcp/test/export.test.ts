import { expect, test } from "vitest";
import { closedByOf } from "../src/server.ts";

test("closedBy is stated only for formats with mandates to close", () => {
  expect(closedByOf("ap2", { pending_close: {} })).toBe("pending");
  expect(closedByOf("ap2", { checkout: {} })).toBe("keelson");
  expect(closedByOf("vi", { l3_checkout: "x" })).toBe("keelson");
  expect(closedByOf("ucp", { complete_request: {} })).toBe("keelson");
  for (const format of ["acp", "tap", "visa"] as const)
    expect(closedByOf(format, {})).toBeUndefined();
});
