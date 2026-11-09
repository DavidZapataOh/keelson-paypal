import "@abraham/reflection";
import { readFileSync } from "node:fs";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import {
  type CertCache,
  CertStore,
  type DeliveryHeaders,
  deliveryHeaders,
  verifyWebhookDelivery,
  WebhookVerificationError,
} from "../src/webhook-verify.ts";

/** A real sandbox signing certificate, served at its cert URL (fetched 2026-11-09). */
const CERT_URL =
  "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d";
const CERT_PEM = readFileSync(
  new URL("fixtures/webhooks/cert-360caa42-fca2a594-ab66f33d.pem", import.meta.url),
  "utf8",
);
/** Inside the certificate's validity (2024-03-08 to 2025-03-07). */
const VALID_AT = new Date("2024-05-16T05:19:24Z");

class MapCache implements CertCache {
  readonly entries = new Map<string, string>();
  async get(key: string) {
    return this.entries.get(key) ?? null;
  }
  async set(key: string, pem: string) {
    this.entries.set(key, pem);
  }
}

async function cacheKey(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return `paypal:cert:${Buffer.from(digest).toString("hex")}`;
}

async function seeded(env: "sandbox" | "production", url: string, pem: string) {
  const cache = new MapCache();
  cache.entries.set(await cacheKey(url), pem);
  return new CertStore(env, cache);
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!(err instanceof WebhookVerificationError)) throw new Error(`expected a refusal, got ${err}`);
  return err.code;
}

const headers = (over: Partial<DeliveryHeaders> = {}): DeliveryHeaders => ({
  transmissionId: "db49fb10-1343-11ef-ac58-e32457403f67",
  transmissionTime: "2024-05-16T05:19:23Z",
  transmissionSig: Buffer.alloc(256).toString("base64"),
  certUrl: CERT_URL,
  authAlgo: "SHA256withRSA",
  ...over,
});
const body = new TextEncoder().encode("{}");

describe("CertStore", () => {
  it("accepts PayPal's certificate, which chains to a pinned DigiCert root", async () => {
    const certs = await seeded("sandbox", CERT_URL, CERT_PEM);
    const leaf = await certs.leaf(CERT_URL, VALID_AT);
    expect(leaf.subject).toContain("CN=messageverificationcerts.sandbox.paypal.com");
    expect(certs.fetches).toBe(0);
  });

  it("refuses the certificate outside its validity", async () => {
    const certs = await seeded("sandbox", CERT_URL, CERT_PEM);
    expect(await codeOf(certs.leaf(CERT_URL, new Date("2025-03-08T00:00:00Z")))).toBe(
      "cert_validity",
    );
  });

  it("refuses a sandbox certificate where the production host is required", async () => {
    const url = "https://api.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d";
    const certs = await seeded("production", url, CERT_PEM);
    expect(await codeOf(certs.leaf(url, VALID_AT))).toBe("cert_host");
  });

  it("refuses a certificate for PayPal's host that is not issued under a pinned root", async () => {
    const alg = {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
      publicExponent: new Uint8Array([1, 0, 1]),
      modulusLength: 2048,
    };
    const caKeys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const leafKeys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
    const ca = await x509.X509CertificateGenerator.createSelfSigned({
      serialNumber: "01",
      name: "CN=DigiCert SHA2 Extended Validation Server CA, OU=www.digicert.com, O=DigiCert Inc, C=US",
      notBefore: new Date("2024-01-01T00:00:00Z"),
      notAfter: new Date("2030-01-01T00:00:00Z"),
      signingAlgorithm: alg,
      keys: caKeys,
      extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
    });
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: "02",
      subject: "CN=messageverificationcerts.sandbox.paypal.com, O=PayPal\\, Inc., C=US",
      issuer: ca.subject,
      notBefore: new Date("2024-01-01T00:00:00Z"),
      notAfter: new Date("2030-01-01T00:00:00Z"),
      signingAlgorithm: alg,
      publicKey: leafKeys.publicKey,
      signingKey: caKeys.privateKey,
      extensions: [
        new x509.SubjectAlternativeNameExtension([
          { type: "dns", value: "messageverificationcerts.sandbox.paypal.com" },
        ]),
      ],
    });
    const certs = await seeded("sandbox", CERT_URL, leaf.toString("pem"));
    expect(await codeOf(certs.leaf(CERT_URL, VALID_AT))).toBe("cert_chain");
  });

  it.each([
    "https://api.sandbox.paypal.com.evil.example/v1/notifications/certs/CERT-x",
    "http://api.sandbox.paypal.com/v1/notifications/certs/CERT-x",
    "https://u:p@api.sandbox.paypal.com/v1/notifications/certs/CERT-x",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x?y=1",
    "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x#y",
    "https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-x",
    "https://api.sandbox.paypal.com/v1/notifications/certs/../CERT-x",
    "https://api.sandbox.paypal.com/v2/certs/x",
    "https://api.paypal.com/v1/notifications/certs/CERT-x",
  ])("refuses the cert URL %s without fetching it", async (url) => {
    const certs = new CertStore("sandbox", new MapCache());
    expect(await codeOf(certs.leaf(url, VALID_AT))).toBe("cert_url");
    expect(
      await codeOf(
        verifyWebhookDelivery({
          headers: headers({ certUrl: url }),
          body,
          webhookId: "WH",
          certs,
          now: VALID_AT,
        }),
      ),
    ).toBe("cert_url");
    expect(certs.fetches).toBe(0);
  });

  it("does not fetch a cert URL again soon after it failed", async () => {
    const certs = new CertStore("sandbox", new MapCache(), () =>
      Promise.reject(new TypeError("fetch failed")),
    );
    expect(await codeOf(certs.leaf(CERT_URL, VALID_AT))).toBe("cert_fetch");
    expect(await codeOf(certs.leaf(CERT_URL, VALID_AT))).toBe("cert_fetch");
    expect(certs.fetches).toBe(1);
  });

  it("reads PayPal's certificate when Key Value is down", async () => {
    const down: CertCache = {
      get: () => Promise.reject(new Error("down")),
      set: () => Promise.reject(new Error("down")),
    };
    const certs = new CertStore("sandbox", down, async () => new Response(CERT_PEM));
    expect((await certs.leaf(CERT_URL, VALID_AT)).subject).toContain("paypal.com");
  });

  it.runIf(process.env.KEELSON_LIVE === "1")(
    "fetches a certificate from PayPal once and validates it",
    async () => {
      const certs = new CertStore("sandbox", new MapCache());
      const leaf = await certs.leaf(CERT_URL, VALID_AT);
      expect(leaf.fingerprint256).toBe(
        new (await import("node:crypto")).X509Certificate(CERT_PEM).fingerprint256,
      );
      await certs.leaf(CERT_URL, VALID_AT);
      expect(certs.fetches).toBe(1);
    },
  );
});

describe("verifyWebhookDelivery", () => {
  it("refuses an algorithm other than SHA256withRSA", async () => {
    const certs = await seeded("sandbox", CERT_URL, CERT_PEM);
    const p = verifyWebhookDelivery({
      headers: headers({ authAlgo: "SHA1withRSA" }),
      body,
      webhookId: "WH",
      certs,
      now: VALID_AT,
    });
    expect(await codeOf(p)).toBe("algorithm");
  });

  it.each([
    [301_000, "stale"],
    [-301_000, "stale"],
  ])(
    "refuses a delivery %i ms from its transmission time before any fetch",
    async (offset, code) => {
      const certs = new CertStore("sandbox", new MapCache());
      const sent = new Date(headers().transmissionTime).getTime();
      const p = verifyWebhookDelivery({
        headers: headers(),
        body,
        webhookId: "WH",
        certs,
        now: new Date(sent + offset),
      });
      expect(await codeOf(p)).toBe(code);
      expect(certs.fetches).toBe(0);
    },
  );

  it("refuses a transmission time that is not RFC 3339", async () => {
    const certs = new CertStore("sandbox", new MapCache());
    const p = verifyWebhookDelivery({
      headers: headers({ transmissionTime: "1715836763" }),
      body,
      webhookId: "WH",
      certs,
      now: VALID_AT,
    });
    expect(await codeOf(p)).toBe("headers");
  });

  it("refuses a signature the certificate did not make", async () => {
    const certs = await seeded("sandbox", CERT_URL, CERT_PEM);
    const p = verifyWebhookDelivery({
      headers: headers(),
      body,
      webhookId: "WH",
      certs,
      now: VALID_AT,
    });
    expect(await codeOf(p)).toBe("signature");
  });
});

describe("deliveryHeaders", () => {
  it("reads the five transmission headers", () => {
    const h = new Headers({
      "paypal-transmission-id": "t",
      "paypal-transmission-time": "2024-05-16T05:19:23Z",
      "paypal-transmission-sig": "s",
      "paypal-cert-url": CERT_URL,
      "paypal-auth-algo": "SHA256withRSA",
    });
    expect(deliveryHeaders(h)).toEqual({
      transmissionId: "t",
      transmissionTime: "2024-05-16T05:19:23Z",
      transmissionSig: "s",
      certUrl: CERT_URL,
      authAlgo: "SHA256withRSA",
    });
  });

  it.each([
    "paypal-transmission-id",
    "paypal-transmission-time",
    "paypal-transmission-sig",
    "paypal-cert-url",
    "paypal-auth-algo",
  ])("refuses a delivery without %s", (name) => {
    const h = new Headers({
      "paypal-transmission-id": "t",
      "paypal-transmission-time": "2024-05-16T05:19:23Z",
      "paypal-transmission-sig": "s",
      "paypal-cert-url": CERT_URL,
      "paypal-auth-algo": "SHA256withRSA",
    });
    h.delete(name);
    expect(() => deliveryHeaders(h)).toThrow(
      expect.objectContaining({ code: "headers" }) as unknown as Error,
    );
  });
});
