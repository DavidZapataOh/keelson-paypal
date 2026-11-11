import { describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { deps } from "./setup.ts";

const platform = createApp({
  ...deps,
  platform: {
    api: "https://api.keelson.finance",
    app: "https://app.keelson.finance",
    origin: "https://keelson-store.onrender.com",
    clientId: "unused",
    clientSecret: "unused",
  },
});

describe("the demo agent platform", () => {
  test("frames only Keelson's API, loads the SDK by nonce, and keeps its popups' opener", async () => {
    const res = await platform.request("/platform");
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-src https://api.keelson.finance");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'nonce-[^']+' https:\/\/app\.keelson\.finance/);
    expect(res.headers.get("cross-origin-opener-policy")).toBe("same-origin-allow-popups");
    const html = await res.text();
    expect(html).toContain('src="https://app.keelson.finance/embed/v1.js"');
  });

  test("is not served without a Keelson client", async () => {
    expect((await createApp(deps).request("/platform")).status).toBe(404);
  });
});
