import { describe, expect, test } from "vitest";
import { AuthenticationError, clientCredentials, Keelson, staticToken } from "../../src/index.ts";

describe.skipIf(process.env.KEELSON_LIVE !== "1")("Keelson's API (live, PayPal sandbox)", () => {
  test("status names each dependency and its environment", async () => {
    const status = await new Keelson({ auth: null }).status();
    expect(["ok", "degraded"]).toContain(status.status);
    expect(status.dependencies.paypal).toMatchObject({ environment: "sandbox" });
    expect(status.dependencies.anchor).toMatchObject({ environment: "arbitrum-sepolia" });
  });

  test("a call with a bad token is an AuthenticationError with a request id", async () => {
    const keelson = new Keelson({ auth: staticToken("not-a-token"), maxRetries: 0 });
    const err = await keelson
      .request("GET", "/v1/purchases/01JX0000000000000000000000")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).requestId).toMatch(/^[0-9A-Z]{26}$/);
  });

  test("a wrong client secret is invalid_client", async () => {
    const auth = clientCredentials({ clientId: "nobody", clientSecret: "wrong" });
    const err = await auth.token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect((err as AuthenticationError).type).toBe("invalid_client");
  });
});
