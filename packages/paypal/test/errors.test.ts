import { describe, expect, it } from "vitest";
import { fromResponse } from "../src/errors.js";

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
    expect(err.details).toEqual([]);
  });
});
