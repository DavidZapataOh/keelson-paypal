import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { holdWithSavedPayPal, mandateHold } from "../src/browser.ts";

/** A stand-in Keelson API on a real socket that answers `/hold` with `hold` and records calls. */
async function api(hold: Record<string, unknown>) {
  const calls: { path: string; body: unknown }[] = [];
  const body = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
      });
      req.on("end", () => resolve(raw ? JSON.parse(raw) : undefined));
    });
  const server: Server = createServer(async (req, res) => {
    const path = req.url ?? "";
    calls.push({ path, body: await body(req) });
    res.setHeader("content-type", "application/json");
    if (path.endsWith("/hold")) return res.end(JSON.stringify(hold));
    if (path.endsWith("/hold/authorize")) {
      return res.end(JSON.stringify({ state: "ACTIVE", authorizationId: "7X5", expiresAt: "" }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  servers.push(server);
  return { origin, calls };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

describe("mandateHold", () => {
  it("says when PayPal needs no approval", async () => {
    const { origin } = await api({ orderId: "8K8", state: "HOLD_PENDING", approved: true });
    expect(await mandateHold(origin, "M1").createOrder()).toEqual({
      orderId: "8K8",
      approved: true,
    });
  });
});

describe("holdWithSavedPayPal", () => {
  it("authorizes a hold the saved PayPal paid, with no PayPal window", async () => {
    const { origin, calls } = await api({ orderId: "8K8", state: "HOLD_PENDING", approved: true });
    expect(await holdWithSavedPayPal(origin, "M1")).toBe("active");
    expect(calls.map((c) => c.path)).toEqual([
      "/v1/mandates/M1/hold",
      "/v1/mandates/M1/hold/authorize",
    ]);
    expect(calls[1]?.body).toEqual({ orderId: "8K8" });
  });

  it("leaves a hold that needs PayPal's approval to the PayPal button", async () => {
    const { origin, calls } = await api({ orderId: "5O1", state: "HOLD_PENDING", approved: false });
    expect(await holdWithSavedPayPal(origin, "M1")).toBe("approve");
    expect(calls.map((c) => c.path)).toEqual(["/v1/mandates/M1/hold"]);
  });
});
