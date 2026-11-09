import { createHash, verify, X509Certificate } from "node:crypto";
import { crc32 } from "node:zlib";
import { INTERMEDIATES, ROOTS } from "./certs/digicert.ts";
import type { PayPalEnv } from "./config.ts";

export type WebhookVerificationCode =
  | "headers"
  | "algorithm"
  | "stale"
  | "cert_url"
  | "cert_fetch"
  | "cert_chain"
  | "cert_host"
  | "cert_validity"
  | "signature"
  | "body";

export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationCode;
  constructor(code: WebhookVerificationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WebhookVerificationError";
    this.code = code;
  }
}

/** The transmission headers PayPal signs a delivery with. */
export interface DeliveryHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

const HEADER_NAMES = {
  transmissionId: "paypal-transmission-id",
  transmissionTime: "paypal-transmission-time",
  transmissionSig: "paypal-transmission-sig",
  certUrl: "paypal-cert-url",
  authAlgo: "paypal-auth-algo",
} as const satisfies Record<keyof DeliveryHeaders, string>;

export function deliveryHeaders(h: Headers): DeliveryHeaders {
  const out = {} as DeliveryHeaders;
  for (const [key, name] of Object.entries(HEADER_NAMES) as [keyof DeliveryHeaders, string][]) {
    const value = h.get(name);
    if (!value) throw new WebhookVerificationError("headers", `${name} is missing`);
    out[key] = value;
  }
  return out;
}

/** Deliveries signed further than this from the verifier's clock are refused. */
const WINDOW_MS = 300_000;
const ALGORITHM = "SHA256withRSA";
const CERT_FETCH_TIMEOUT_MS = 3_000;
const MAX_CERT_BYTES = 16 * 1024;
/** A cached certificate is fetched again after a signature failure at most this often. */
const REFRESH_INTERVAL_MS = 600_000;

const CERT_HOSTS: Record<PayPalEnv, { url: RegExp; san: string }> = {
  sandbox: {
    url: /^https:\/\/api\.sandbox\.paypal\.com\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,100}$/,
    san: "messageverificationcerts.sandbox.paypal.com",
  },
  production: {
    url: /^https:\/\/api\.paypal\.com\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]{1,100}$/,
    san: "messageverificationcerts.paypal.com",
  },
};

const roots = ROOTS.map((pem) => new X509Certificate(pem));
const intermediates = INTERMEDIATES.map((pem) => new X509Certificate(pem));

const within = (c: X509Certificate, at: Date) =>
  c.validFromDate.getTime() <= at.getTime() && at.getTime() <= c.validToDate.getTime();

/** Shared storage for fetched certificates, such as Key Value. */
export interface CertCache {
  get(key: string): Promise<string | null>;
  set(key: string, pem: string, ttlSeconds: number): Promise<void>;
}

interface Cached {
  /** Leaf, intermediate and root. */
  chain: [X509Certificate, X509Certificate, X509Certificate];
  fetchedAt: number;
}

/**
 * PayPal's webhook signing certificates, fetched only from PayPal's cert URLs and kept only once
 * they chain to a pinned DigiCert root and name PayPal's message verification host.
 */
export class CertStore {
  readonly #san: string;
  readonly #url: RegExp;
  readonly #shared: CertCache | undefined;
  readonly #fetch: typeof fetch;
  readonly #memory = new Map<string, Cached>();
  readonly #pending = new Map<string, Promise<Cached>>();
  #fetches = 0;

  constructor(env: PayPalEnv, shared?: CertCache, fetchImpl: typeof fetch = fetch) {
    this.#san = CERT_HOSTS[env].san;
    this.#url = CERT_HOSTS[env].url;
    this.#shared = shared;
    this.#fetch = fetchImpl;
  }

  /** How many times a certificate was fetched from PayPal. */
  get fetches(): number {
    return this.#fetches;
  }

  /** Throws `cert_url` for a URL that is not one of PayPal's cert URLs. */
  checkUrl(url: string): void {
    if (!this.#url.test(url)) {
      throw new WebhookVerificationError("cert_url", "the cert URL is not PayPal's");
    }
  }

  /**
   * The signing certificate at `url`, valid at `at`. With `refresh`, a certificate cached in
   * this process is fetched again, at most once per ten minutes.
   */
  async leaf(url: string, at: Date, refresh = false): Promise<X509Certificate> {
    this.checkUrl(url);
    let cached = this.#memory.get(url);
    if (cached && refresh && Date.now() - cached.fetchedAt >= REFRESH_INTERVAL_MS) {
      this.#memory.delete(url);
      cached = await this.#load(url, true);
    }
    cached ??= await this.#load(url, false);
    if (!cached.chain.every((c) => within(c, at))) {
      throw new WebhookVerificationError("cert_validity", "the certificate is not valid now");
    }
    return cached.chain[0];
  }

  #load(url: string, skipShared: boolean): Promise<Cached> {
    const inFlight = this.#pending.get(url);
    if (inFlight) return inFlight;
    const loading = this.#read(url, skipShared).finally(() => this.#pending.delete(url));
    this.#pending.set(url, loading);
    return loading;
  }

  async #read(url: string, skipShared: boolean): Promise<Cached> {
    const key = `paypal:cert:${createHash("sha256").update(url).digest("hex")}`;
    const shared = skipShared ? null : await this.#shared?.get(key);
    const pem = shared ?? (await this.#download(url));
    const cached: Cached = { chain: this.#chain(this.#parse(pem)), fetchedAt: Date.now() };
    this.#memory.set(url, cached);
    const ttl = Math.floor((cached.chain[0].validToDate.getTime() - Date.now()) / 1000);
    if (!shared && ttl > 0) await this.#shared?.set(key, pem, ttl);
    return cached;
  }

  async #download(url: string): Promise<string> {
    this.#fetches++;
    let res: Response;
    try {
      res = await this.#fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new WebhookVerificationError("cert_fetch", "the cert URL did not answer", { cause });
    }
    if (!res.ok || !res.body) {
      throw new WebhookVerificationError("cert_fetch", `the cert URL answered ${res.status}`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_CERT_BYTES) {
        throw new WebhookVerificationError("cert_fetch", "the certificate is too large");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  #parse(pem: string): X509Certificate {
    try {
      return new X509Certificate(pem);
    } catch (cause) {
      throw new WebhookVerificationError("cert_chain", "the certificate does not parse", {
        cause,
      });
    }
  }

  /** The leaf's chain to a pinned root; the leaf must name PayPal's message verification host. */
  #chain(leaf: X509Certificate): Cached["chain"] {
    const issuer = intermediates.find((i) => leaf.checkIssued(i) && leaf.verify(i.publicKey));
    const root = issuer && roots.find((r) => issuer.checkIssued(r) && issuer.verify(r.publicKey));
    if (!issuer?.ca || !root) {
      throw new WebhookVerificationError(
        "cert_chain",
        `the certificate is not issued under a pinned root (issuer ${leaf.issuer.replaceAll("\n", ", ")})`,
      );
    }
    if (leaf.checkHost(this.#san, { subject: "never" }) !== this.#san) {
      throw new WebhookVerificationError("cert_host", "the certificate does not name PayPal");
    }
    return [leaf, issuer, root];
  }
}

/** What a verified delivery says, read only after its signature verified. */
export interface VerifiedDelivery {
  eventId: string;
  eventType: string;
  resourceType: string;
  /** `resource.id`, or `resource.dispute_id` for disputes. */
  resourceId: string;
  transmissionId: string;
  transmissionTime: Date;
}

const RFC3339 = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$/;

/**
 * Verifies a delivery the way PayPal documents self-verification: `SHA256withRSA` over
 * `transmission_id|transmission_time|webhook_id|crc32(body)`, with `webhook_id` from configuration
 * and the CRC-32 of the exact body bytes, under a certificate from PayPal's cert URL.
 */
export async function verifyWebhookDelivery(input: {
  headers: DeliveryHeaders;
  body: Uint8Array;
  webhookId: string;
  certs: CertStore;
  now?: Date;
}): Promise<VerifiedDelivery> {
  const { headers, body, webhookId, certs } = input;
  const now = input.now ?? new Date();
  if (headers.authAlgo !== ALGORITHM) {
    throw new WebhookVerificationError("algorithm", `${headers.authAlgo} is not ${ALGORITHM}`);
  }
  const sent = new Date(headers.transmissionTime);
  if (!RFC3339.test(headers.transmissionTime) || Number.isNaN(sent.getTime())) {
    throw new WebhookVerificationError("headers", "paypal-transmission-time is not a time");
  }
  if (Math.abs(now.getTime() - sent.getTime()) > WINDOW_MS) {
    throw new WebhookVerificationError("stale", "the delivery is outside the five minute window");
  }
  certs.checkUrl(headers.certUrl);

  const signed = Buffer.from(
    `${headers.transmissionId}|${headers.transmissionTime}|${webhookId}|${crc32(body) >>> 0}`,
  );
  const signature = Buffer.from(headers.transmissionSig, "base64");
  const valid = (leaf: X509Certificate) => verify("sha256", signed, leaf.publicKey, signature);
  if (
    !valid(await certs.leaf(headers.certUrl, now)) &&
    !valid(await certs.leaf(headers.certUrl, now, true))
  ) {
    throw new WebhookVerificationError("signature", "the signature does not verify");
  }

  let event: {
    id?: unknown;
    event_type?: unknown;
    resource_type?: unknown;
    resource?: { id?: unknown; dispute_id?: unknown };
  };
  try {
    event = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch (cause) {
    throw new WebhookVerificationError("body", "the body is not JSON", { cause });
  }
  const resourceId = event?.resource?.id ?? event?.resource?.dispute_id;
  if (
    typeof event?.id !== "string" ||
    typeof event.event_type !== "string" ||
    typeof event.resource_type !== "string" ||
    typeof resourceId !== "string"
  ) {
    throw new WebhookVerificationError("body", "the body is not a webhook event");
  }
  return {
    eventId: event.id,
    eventType: event.event_type,
    resourceType: event.resource_type,
    resourceId,
    transmissionId: headers.transmissionId,
    transmissionTime: sent,
  };
}
