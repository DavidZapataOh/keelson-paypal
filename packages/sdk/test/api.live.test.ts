import { ALIBI_MEDIA_TYPE } from "@keelson/alibi";
import { describe, expect, test } from "vitest";
import {
  clientCredentials,
  createAuthorizationRequest,
  fetchAlibi,
  Keelson,
  KeelsonAgent,
  KeelsonError,
  OAuthError,
  registerPublicClient,
  unwrap,
  verifyAlibi,
} from "../src/index.ts";

// The generated client against Keelson's API on the PayPal sandbox, with no credentials.
const live = describe.runIf(process.env.KEELSON_LIVE === "1");

const keelson = new Keelson();

/** A purchase with an Alibi in Keelson's log, read from the public list of live purchases. */
async function loggedPurchase(): Promise<string> {
  const { purchases } = await unwrap(keelson.listLivePurchases());
  const logged = purchases.find((p) => p.logIndex !== null);
  if (!logged) throw new Error("no live purchase has reached the log");
  return logged.id;
}

live("Keelson's API, generated client", () => {
  test("reads typed answers", async () => {
    const health = await unwrap(keelson.getHealth());
    expect(health.status).toBe("ok");
    const { data, response } = await keelson.getAlibiReceipt({
      path: { id: await loggedPurchase() },
    });
    expect(response?.status).toBe(200);
    expect(data?.leaf_hash).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("an answer that is not 2xx is a typed problem", async () => {
    const missing = await unwrap(
      keelson.getAlibiReceipt({ path: { id: "01J00000000000000000000000" } }),
    ).catch((e: unknown) => e);
    expect(missing).toBeInstanceOf(KeelsonError);
    expect((missing as KeelsonError).status).toBe(404);
    const anonymous = await unwrap(
      keelson.getPurchase({ path: { id: "01J00000000000000000000000" } }),
    ).catch((e: unknown) => e);
    expect((anonymous as KeelsonError).status).toBe(401);
    expect((anonymous as KeelsonError).type).toBe("unauthorized");
  });

  test("a write without a token answers an error envelope that is not retryable", async () => {
    const answer = await new KeelsonAgent(keelson).requestMandate({
      name: "SDK test",
      reason: "x".repeat(120),
      perPurchaseMinor: 1000,
      totalMinor: 2000,
      until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(answer.status).toBe("error");
    expect(answer.retryable).toBe(false);
    expect(answer.next.action).toBe("tell_user");
    expect(answer.message).toContain("401");
  });

  test("Keelson replays a POST sent again with the same Idempotency-Key", async () => {
    const res = await fetch(`${keelson.baseUrl}/v1/alibis/${await loggedPurchase()}`);
    const bundle = new Uint8Array(await res.arrayBuffer());
    const send = () =>
      fetch(`${keelson.baseUrl}/v1/alibis/verify`, {
        method: "POST",
        headers: { "content-type": ALIBI_MEDIA_TYPE, "idempotency-key": key },
        body: bundle,
      });
    const key = crypto.randomUUID();
    const first = await send();
    const second = await send();
    expect(first.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(await second.json()).toEqual(await first.json());
  });
});

live("offline Alibi verification", () => {
  test("a live Alibi verifies offline with the reference verifier", async () => {
    const bundle = await fetchAlibi(keelson, await loggedPurchase());
    const report = await verifyAlibi(bundle);
    expect(report.verdict).toBe("verified-offline");
    const failed = report.checks.filter((c) => c.status === "fail");
    expect(failed).toEqual([]);
    expect(report.checks.find((c) => c.id === "tee.countersign")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "log.inclusion")?.status).toBe("pass");
  });

  test("with the chain read, the anchor on Arbitrum Sepolia verifies too", async () => {
    const report = await verifyAlibi(await fetchAlibi(keelson, await loggedPurchase()), {
      chain: true,
    });
    expect(report.verdict).toBe("verified");
  });

  test("one changed byte fails it", async () => {
    const bundle = await fetchAlibi(keelson, await loggedPurchase());
    const forged = structuredClone(bundle);
    (forged.eval as { decision: string }).decision =
      bundle.eval.decision === "allow" ? "deny" : "allow";
    const report = await verifyAlibi(forged);
    expect(report.verdict).toBe("failed");
  });

  test("the public receipt verifies, with the sections it does not carry undisclosed", async () => {
    const receipt = await unwrap(keelson.getAlibiReceipt({ path: { id: await loggedPurchase() } }));
    const report = await verifyAlibi(receipt);
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.checks.find((c) => c.id === "log.inclusion")?.status).toBe("pass");
    expect(report.checks.find((c) => c.id === "tee.countersign")?.status).toBe("undisclosed");
  });
});

live("OAuth", () => {
  test("client credentials with a wrong secret is an OAuth error", async () => {
    const auth = clientCredentials({
      clientId: "not-a-client",
      clientSecret: "wrong",
      scopes: ["countersign:write"],
    });
    const err = await auth.token().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OAuthError);
    expect((err as OAuthError).error).toBe("invalid_client");
  });

  test("an app registers as a public client and starts the PKCE flow", async () => {
    const redirectUri = "http://127.0.0.1:8976/callback";
    const clientId = await registerPublicClient({
      clientName: "Keelson SDK test",
      redirectUris: [redirectUri],
    });
    const request = await createAuthorizationRequest({ clientId, redirectUri });
    const url = new URL(request.url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe("https://api.keelson.finance");
    // The authorization server accepts the request and sends the user to sign in.
    const res = await fetch(request.url, { redirect: "manual" });
    expect(res.status).toBe(200);
    const { url: next } = (await res.json()) as { url: string };
    const location = new URL(next);
    expect(location.searchParams.get("error")).toBeNull();
    expect(location.origin).toBe("https://app.keelson.finance");
    expect(location.searchParams.get("code_challenge")).toBe(
      url.searchParams.get("code_challenge"),
    );
  });
});
