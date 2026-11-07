import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { type Cart, CURRENCIES, type CurrencyCode, cartHash, toHex } from "@keelson/core";
import { type Db, operators, passkey as passkeyTable, user } from "@keelson/db";
import {
  closeMandate,
  type Mandate,
  merchantLeaf,
  parseMandate,
  prepareSigning,
} from "@keelson/mandate";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { MiddlewareHandler } from "hono";
import { type Browser, type CDPSession, chromium, type Page } from "playwright";
import { ulid } from "ulid";
import { bytesToHex } from "viem";
import cartBundle from "../../../engine/canon/tests/fixtures/bundle-340.json" with { type: "json" };
import cartDemo from "../../../engine/canon/tests/fixtures/demo-shoes.json" with { type: "json" };
import demo from "../../../packages/mandate/test/fixtures/demo-mandate.json" with { type: "json" };
import type { Principal } from "../src/principal.ts";
import type { CountersignRequest, LegClient, MandateIssued } from "../src/tee/client.ts";
import type { CountersignExpectation } from "../src/tee/coordinator.ts";

export const live = process.env.KEELSON_LIVE === "1";

export const liveEnv = () => ({
  TEE_A_URL: process.env.TEE_A_URL as string,
  TEE_B_URL: process.env.TEE_B_URL as string,
  KEELSON_TEE_TOKEN: process.env.KEELSON_TEE_TOKEN as string,
  ARBITRUM_SEPOLIA_RPC_URL: process.env.ARBITRUM_SEPOLIA_RPC_URL,
  KEELSON_ISSUER_THUMBPRINT: process.env.KEELSON_ISSUER_THUMBPRINT as `0x${string}`,
});

/** The origin the deployed legs accept passkey assertions on; its RP ID is `keelson.finance`. */
const ORIGIN = "https://app.keelson.finance";
const RP_ID = "keelson.finance";

export interface Assertion {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

/** What mandate signing needs of a passkey. */
export interface Passkey {
  readonly credentialId: string;
  readonly jwk: { kty: string; crv: string; x: string; y: string };
  assert(challenge: Uint8Array): Promise<Assertion>;
  close(): Promise<void>;
}

/**
 * A software authenticator: it signs WebAuthn assertions (`authenticatorData`, `clientDataJSON`
 * and an ES256 signature) for the origin the legs expect, with no browser.
 */
export class SoftwarePasskey implements Passkey {
  readonly credentialId = randomBytes(16).toString("base64url");
  readonly jwk: { kty: string; crv: string; x: string; y: string };
  private readonly privateKey;
  private counter = 0;

  private constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.jwk = pair.publicKey.export({ format: "jwk" }) as typeof this.jwk;
  }

  static create(): Promise<SoftwarePasskey> {
    return Promise.resolve(new SoftwarePasskey());
  }

  assert(challenge: Uint8Array): Promise<Assertion> {
    const flags = Buffer.from([0x05]);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(++this.counter);
    const authenticatorData = Buffer.concat([
      createHash("sha256").update(RP_ID).digest(),
      flags,
      counter,
    ]);
    const clientDataJSON = Buffer.from(
      JSON.stringify({
        type: "webauthn.get",
        challenge: Buffer.from(challenge).toString("base64url"),
        origin: ORIGIN,
        crossOrigin: false,
      }),
    );
    const signature = sign(
      "sha256",
      Buffer.concat([authenticatorData, createHash("sha256").update(clientDataJSON).digest()]),
      { key: this.privateKey, dsaEncoding: "der" },
    );
    return Promise.resolve({
      authenticatorData: authenticatorData.toString("base64url"),
      clientDataJSON: clientDataJSON.toString("base64url"),
      signature: signature.toString("base64url"),
    });
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

/** A passkey held by Chrome's virtual authenticator, on the origin the legs expect. */
export class VirtualPasskey implements Passkey {
  private readonly browser: Browser;
  private readonly page: Page;
  readonly credentialId: string;
  readonly jwk: { kty: string; crv: string; x: string; y: string };

  private constructor(
    browser: Browser,
    page: Page,
    credentialId: string,
    jwk: { kty: string; crv: string; x: string; y: string },
  ) {
    this.browser = browser;
    this.page = page;
    this.credentialId = credentialId;
    this.jwk = jwk;
  }

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

export interface SignedMandate {
  sub: string;
  key: CryptoKey;
  salt: Buffer;
  assertion: Assertion;
  /** The body of `POST /v1/mandates`. */
  body: {
    payloadSd: object;
    disclosures: string[];
    commitment: string;
    salt: string;
    assertion: Assertion & { credentialId: string };
  };
}

/** The demo mandate for `sub` and a new agent key, signed with `passkey`. */
export async function signedMandate(
  passkey: Passkey,
  sub = `kls_usr_${randomBytes(8).toString("hex")}`,
): Promise<SignedMandate> {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const agentJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const merchant = await authorizationPayee();
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
  return {
    sub,
    key: pair.privateKey,
    salt,
    assertion,
    body: {
      payloadSd: signing.payloadSd,
      disclosures: signing.disclosures,
      commitment: signing.commitment,
      salt: signing.salt,
      assertion: { ...assertion, credentialId: passkey.credentialId },
    },
  };
}

/** Registers the demo mandate for a new user and a new agent key on leg A. */
export async function registerMandate(leg: LegClient, passkey: Passkey): Promise<Agent> {
  const signed = await signedMandate(passkey);
  const issued = await leg.registerMandate({
    sub: signed.sub,
    payload_sd: signed.body.payloadSd,
    disclosures: signed.body.disclosures,
    assertion: signed.assertion,
    salt: `0x${signed.salt.toString("hex")}`,
  });
  return { sub: signed.sub, issued, key: signed.key };
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

/** What the countersign for `req` has to say, from the request alone. */
export async function expectation(
  agent: Agent,
  req: CountersignRequest,
): Promise<CountersignExpectation> {
  const cart = req.cart as Cart;
  return {
    cartHash: toHex(cartHash(cart)),
    amount: cart.lines.reduce((sum, l) => sum + BigInt(l.qty) * BigInt(l.unit_minor), 0n),
    merchantId: `0x${(await merchantLeaf(cart.merchant)).toString(16).padStart(64, "0")}`,
    currency: CURRENCIES[cart.currency as CurrencyCode].numeric,
    mandateHash: agent.issued.mandate_hash,
  };
}

export { toHex };

/** A signed-in user whose passkey is the virtual one, and the operator the demo mandate names. */
export async function seedUser(db: Db, passkey: Passkey, sub: string): Promise<void> {
  const x = Buffer.from(passkey.jwk.x, "base64url");
  const y = Buffer.from(passkey.jwk.y, "base64url");
  const cose = isoCBOR.encode(
    new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
  await db.insert(user).values({ id: sub, name: "Tester", email: `${sub}@example.test` });
  await db.insert(passkeyTable).values({
    id: randomBytes(8).toString("hex"),
    publicKey: Buffer.from(cose).toString("base64"),
    userId: sub,
    credentialID: passkey.credentialId,
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
  });
  await db
    .insert(operators)
    .values({ agentId: 42n, chainId: 421614, name: "Demo operator", cnfJwk: {} })
    .onConflictDoNothing();
}

/** Resolves the principal from a header, in place of the OAuth and session lookups. */
export const headerPrincipal: MiddlewareHandler = async (c, next) => {
  const who = c.req.header("x-test-principal");
  if (who) c.set("principal", JSON.parse(who) as Principal);
  await next();
};

export const asUser = (sub: string) => ({
  "x-test-principal": JSON.stringify({ kind: "user", subject: sub }),
});
export const asAgent = {
  "x-test-principal": JSON.stringify({
    kind: "client",
    subject: "demo-agent",
    scopes: ["countersign:write"],
  }),
};
