import { describe, expect, test } from "vitest";
import { assertLocalHost } from "../bench/host.ts";

describe("assertLocalHost", () => {
  test.each([
    "postgres://postgres:pw@localhost:5432/k",
    "postgres://postgres:pw@127.0.0.1:5432/k",
    "postgres://postgres:pw@[::1]:5432/k",
    "postgres://localhost/k?host=/var/run/postgresql",
    "postgres://localhost/k?host=/tmp",
    "postgres://localhost/k?host=evil.com&host=localhost",
  ])("accepts %s", (url) => {
    expect(() => assertLocalHost(url)).not.toThrow();
  });

  test.each([
    "postgres://localhost/x?host=evil.com",
    "postgres://postgres:pw@localhost.evil.com:5432/k",
    "postgres://evil.com/k",
    "postgres://localhost/k?hostaddr=1.2.3.4",
    "postgres://localhost/k?host=/etc/sockets",
    "postgres://localhost/k?host=/tmp/../etc",
    "postgres:///k",
    "postgres://localhost/k?host=localhost,evil.com",
    "postgres://localhost/k?host=localhost&host=evil.com",
  ])("rejects %s", (url) => {
    expect(() => assertLocalHost(url)).toThrow(/refusing/);
  });
});
