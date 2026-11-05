import { ApiError } from "@paypal/paypal-server-sdk";
import { describe, expect, it } from "vitest";
import { paypalConfig } from "../src/config.ts";
import { fromResponse, fromSdkError, PayPalError } from "../src/errors.ts";

describe("fromResponse", () => {
  it("parses the REST error shape and the debug id", async () => {
    const res = new Response(
      JSON.stringify({
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed.",
        debug_id: "abc123",
        details: [{ issue: "ORDER_NOT_APPROVED", description: "Not approved", field: "/id" }],
      }),
      { status: 422 },
    );
    const err = await fromResponse(res);
    expect(err.status).toBe(422);
    expect(err.name).toBe("UNPROCESSABLE_ENTITY");
    expect(err.debugId).toBe("abc123");
    expect(err.details).toEqual([
      { issue: "ORDER_NOT_APPROVED", description: "Not approved", field: "/id" },
    ]);
  });

  it("parses the OAuth error shape and falls back to the debug header", async () => {
    const res = new Response(
      JSON.stringify({
        error: "invalid_client",
        error_description: "Client Authentication failed",
      }),
      { status: 401, headers: { "paypal-debug-id": "hdr456" } },
    );
    const err = await fromResponse(res);
    expect(err.status).toBe(401);
    expect(err.name).toBe("invalid_client");
    expect(err.message).toBe("Client Authentication failed");
    expect(err.debugId).toBe("hdr456");
  });

  it("tolerates a non-JSON body", async () => {
    const err = await fromResponse(new Response("Bad Gateway", { status: 502 }));
    expect(err.status).toBe(502);
    expect(err.name).toBe("PAYPAL_ERROR");
    expect(err.message).toBe("PayPal request failed with HTTP 502");
    expect(err.details).toEqual([]);
  });
});

describe("fromSdkError", () => {
  const apiError = (body: string) =>
    new ApiError(
      {
        request: { method: "GET", url: "https://api-m.sandbox.paypal.com/v2/x" },
        response: { statusCode: 404, headers: { "paypal-debug-id": "dbg789" }, body },
      },
      "not found",
    );

  it("converts an SDK ApiError and reads the debug header", () => {
    const err = fromSdkError(
      apiError(JSON.stringify({ name: "RESOURCE_NOT_FOUND", message: "Missing" })),
    );
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({
      status: 404,
      name: "RESOURCE_NOT_FOUND",
      message: "Missing",
      debugId: "dbg789",
    });
  });

  it("passes any other error through unchanged", () => {
    const original = new TypeError("boom");
    expect(fromSdkError(original)).toBe(original);
  });
});

describe("paypalConfig", () => {
  const env = { PAYPAL_ENV: "sandbox", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" };

  it("selects the base URL for the environment", () => {
    expect(paypalConfig(env).baseUrl).toBe("https://api-m.sandbox.paypal.com");
  });

  it("rejects an unknown environment", () => {
    expect(() => paypalConfig({ ...env, PAYPAL_ENV: "live" })).toThrow(/PAYPAL_ENV/);
  });

  it("requires the client credentials", () => {
    expect(() => paypalConfig({ ...env, PAYPAL_CLIENT_SECRET: "" })).toThrow(
      "PAYPAL_CLIENT_SECRET is required",
    );
  });
});
