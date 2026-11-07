import { createPublicKey, randomBytes } from "node:crypto";
import { cartHash, toHex } from "@keelson/core";
import { closeMandate, type Mandate, parseMandate, prepareSigning } from "@keelson/mandate";
import { type Browser, type CDPSession, chromium, type Page } from "playwright";
import { ulid } from "ulid";
import { bytesToHex } from "viem";
import cartBundle from "../../../engine/canon/tests/fixtures/bundle-340.json" with { type: "json" };
import cartDemo from "../../../engine/canon/tests/fixtures/demo-shoes.json" with { type: "json" };
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import type { CountersignRequest, LegClient, MandateIssued } from "../src/tee/client.ts";

export const live = process.env.KEELSON_LIVE === "1";

export const liveEnv = () => ({
  TEE_A_URL: process.env.TEE_A_URL as string,
  TEE_B_URL: process.env.TEE_B_URL as string,
  KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
  ARBITRUM_SEPOLIA_RPC_URL: process.env.ARBITRUM_SEPOLIA_RPC_URL,
});

/** The origin the deployed legs accept passkey assertions on; its RP ID is `keelson.finance`. */
const ORIGIN = "https://app.keelson.finance";
const RP_ID = "keelson.finance";

export interface Assertion {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** A passkey held by Chrome's virtual authenticator, on the origin the legs expect. */
export class VirtualPasskey {
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
    readonly credentialId: string,
    readonly jwk: { kty: string; crv: string; x: string; y: string },
  ) {}

  static async create(): Promise<VirtualPasskey> {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ contentType: "text/html", body: "<!doctype html><title>passkey</title>" }),
    );
    await page.goto(ORIGIN);
    const cdp: CDPSession = await page.context().newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    const created = await page.evaluate(
      async ({ rpId }) => {
        const b64u = (buf: ArrayBuffer) =>
          btoa(String.fromCharCode(...new Uint8Array(buf)))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
        const credential = (await navigator.credentials.create({
          publicKey: {
            rp: { id: rpId, name: "Keelson" },
            user: {
              id: crypto.getRandomValues(new Uint8Array(16)),
              name: "tester",
              displayName: "tester",
            },
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            authenticatorSelection: { residentKey: "required", userVerification: "required" },
          },
        })) as PublicKeyCredential;
        const response = credential.response as AuthenticatorAttestationResponse;
        return { id: credential.id, spki: b64u(response.getPublicKey() as ArrayBuffer) };
      },
      { rpId: RP_ID },
    );
    const jwk = createPublicKey({
      key: Buffer.from(created.spki, "base64url"),
      format: "der",
      type: "spki",
    }).export({ format: "jwk" }) as { kty: string; crv: string; x: string; y: string };
    return new VirtualPasskey(browser, page, created.id, jwk);
  }

  async assert(challenge: Uint8Array): Promise<Assertion> {
    return this.page.evaluate(
      async ({ challenge, id, rpId }) => {
        const b64u = (buf: ArrayBuffer) =>
          btoa(String.fromCharCode(...new Uint8Array(buf)))
            .replaceAll("+", "-")
            .replaceAll("/", "_")
            .replaceAll("=", "");
        const credential = (await navigator.credentials.get({
          publicKey: {
            challenge: Uint8Array.from(challenge),
            rpId,
            userVerification: "required",
            allowCredentials: [
              {
                type: "public-key",
                id: Uint8Array.from(atob(id.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
                  c.charCodeAt(0),
                ),
              },
            ],
          },
        })) as PublicKeyCredential;
        const r = credential.response as AuthenticatorAssertionResponse;
        return {
          authenticatorData: b64u(r.authenticatorData),
          clientDataJSON: b64u(r.clientDataJSON),
          signature: b64u(r.signature),
        };
      },
      { challenge: [...challenge], id: this.credentialId, rpId: RP_ID },
    );
  }

  async close(): Promise<void> {
    await this.browser.close();
  }
}

let payee: Promise<string> | undefined;

/** The merchant the sandbox authorization pays, which the mandate must allow. */
function authorizationPayee(): Promise<string> {
  payee ??= (async () => {
    const base = "https://api-m.sandbox.paypal.com";
    const basic = Buffer.from(
      `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`,
    ).toString("base64");
    const token = (await (
      await fetch(`${base}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          authorization: `Basic ${basic}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      })
    ).json()) as { access_token: string };
    const auth = (await (
      await fetch(
        `${base}/v2/payments/authorizations/${process.env.PAYPAL_AUTHORIZATION_CREATED}`,
        {
          headers: { authorization: `Bearer ${token.access_token}` },
        },
      )
    ).json()) as { payee: { merchant_id: string } };
    return auth.payee.merchant_id;
  })();
  return payee;
}

export interface Agent {
  sub: string;
  issued: MandateIssued;
  key: CryptoKey;
}

/** Registers the demo mandate for a new user and a new agent key on leg A. */
export async function registerMandate(leg: LegClient, passkey: VirtualPasskey): Promise<Agent> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const agentJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const merchant = await authorizationPayee();
  const sub = `kls_usr_${randomBytes(8).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  const m: Mandate = parseMandate({
    ...demo,
    nbf: now - 60,
    exp: now + 7 * 86_400,
    user: {
      ...demo.user,
      sub,
      cred: { id: passkey.credentialId, rp_id: RP_ID, jwk: passkey.jwk },
    },
    payment: {
      ...demo.payment,
      constraints: demo.payment.constraints.map((c) =>
        c.type === "payment.allowed_payees"
          ? { ...c, allowed: [{ paypal_merchant_id: merchant }] }
          : c,
      ),
    },
    agent: {
      ...demo.agent,
      cnf: { jwk: { kty: "EC", crv: "P-256", kid: "agt-01", x: agentJwk.x, y: agentJwk.y } },
    },
  });
  const salt = randomBytes(16);
  const signing = await prepareSigning(
    m,
    salt,
    { merchantSignedCheckout: false, zkTlsFields: new Set() },
    [],
  );
  const assertion = await passkey.assert(signing.challenge);
  const issued = await leg.registerMandate({
    sub,
    payload_sd: signing.payloadSd,
    disclosures: signing.disclosures,
    assertion,
    salt: `0x${salt.toString("hex")}`,
  });
  return { sub, issued, key: pair.privateKey };
}

export const carts = { demo: cartDemo, bundle: cartBundle } as const;

/** A countersign request for `cart`, closed by the agent. */
export async function request(
  agent: Agent,
  cart: (typeof carts)[keyof typeof carts],
  requestId: string = ulid(),
): Promise<CountersignRequest> {
  const hash = bytesToHex(cartHash(cart.cart)).replace("0x", "");
  return {
    request_id: requestId,
    closed_mandate: await closeMandate(
      agent.issued.open_mandate,
      { requestId, cartHash: `sha256:${hash}` },
      agent.key,
    ),
    sub: agent.sub,
    cart: cart.cart,
    unit: cart.unit,
    evidence: {},
    evidence_root: `0x${"55".repeat(32)}`,
    authorization_id: process.env.PAYPAL_AUTHORIZATION_CREATED as string,
  };
}

export { toHex };
