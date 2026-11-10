import { describe, expect, test } from "vitest";
import { isAllowed } from "../src/policy.ts";

const HOSTS = ["store.keelson.finance", "keelson-store.onrender.com"];

describe("the browser's host allowlist", () => {
  test.each([
    "https://store.keelson.finance/products/tempo-3",
    "store.keelson.finance/l/abc",
    "http://keelson-store.onrender.com/",
    "about:blank",
  ])("allows %s", (url) => expect(isAllowed(url, HOSTS)).toBe(true));

  test.each([
    "https://evil.example/",
    "https://store.keelson.finance.evil.example/",
    "https://api.store.keelson.finance/",
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "file:///etc/passwd",
    "view-source:https://store.keelson.finance/",
    "wss://store.keelson.finance/socket",
    "https://evil.example\\@store.keelson.finance/",
    "https://169.254.169.254/latest/meta-data/",
  ])("refuses %s", (url) => expect(isAllowed(url, HOSTS)).toBe(false));
});
