import { expect, test } from "vitest";
import { principalChannel, principalKey } from "../src/principal.ts";

const user = { kind: "user", subject: "u1" } as const;

test("principalKey is base64url of kind:subject", () => {
  expect(principalKey(user)).toBe("dXNlcjp1MQ");
  expect(principalKey({ kind: "client", subject: "agent-7" })).toBe("Y2xpZW50OmFnZW50LTc");
});

test("principalChannel is the key, optionally followed by :suffix", () => {
  expect(principalChannel(user)).toBe("dXNlcjp1MQ");
  expect(principalChannel(user, "mandates")).toBe("dXNlcjp1MQ:mandates");
  expect(principalChannel(user, "m:01J_x-y")).toBe("dXNlcjp1MQ:m:01J_x-y");
});

test("principalChannel rejects suffixes outside the channel grammar", () => {
  for (const bad of ["", "a.b", "a b", "x".repeat(128)]) {
    expect(() => principalChannel(user, bad)).toThrow(RangeError);
  }
});

test("a subject containing ':' cannot collide across kinds", () => {
  const spoof = { kind: "user", subject: "client:x" } as const;
  const client = { kind: "client", subject: "x" } as const;
  expect(principalKey(spoof)).toBe("dXNlcjpjbGllbnQ6eA");
  expect(principalKey(client)).toBe("Y2xpZW50Ong");
  expect(principalChannel(spoof, "s")).not.toBe(principalChannel(client, "s"));
  expect(principalChannel(spoof).startsWith(`${principalChannel(client)}:`)).toBe(false);
  expect(principalChannel(client).startsWith(`${principalChannel(spoof)}:`)).toBe(false);
});
