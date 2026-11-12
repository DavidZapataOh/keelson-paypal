import type Anthropic from "@anthropic-ai/sdk";
import { httpInstrumentationMiddleware } from "@hono/otel";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { ChainReader } from "@keelson/alibi/verify";
import type { Db } from "@keelson/db";
import type { CertStore } from "@keelson/paypal";
import type { Relayer } from "@keelson/relayer";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { timeout } from "hono/timeout";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";
import type { RedisClientType } from "redis";
import { ulid } from "ulid";
import { type Address, BaseError, HttpRequestError, TimeoutError } from "viem";
import { type Auth, apiAudience, SCOPE_DESCRIPTIONS } from "./auth.ts";
import type { CardIssuer } from "./cards/issuer.ts";
import type { ChainReaders } from "./chain/reader.ts";
import type { Channel3Lookup } from "./channel3/client.ts";
import { registerContext } from "./context.ts";
import type { HostedCaps } from "./hosted-caps.ts";
import type { LogConfig } from "./log/append.ts";
import { requestLogger } from "./logger.ts";
import { registerMcp } from "./mcp.ts";
import { requireClient, securityOf } from "./middleware/auth.ts";
import { idempotency } from "./middleware/idempotency.ts";
import { type RateLimitOptions, rateLimit } from "./middleware/rate-limit.ts";
import type { Notifier } from "./notify/notifier.ts";
import type { OperatorSigners } from "./operators/signer.ts";
import type { PayPalDeps } from "./paypal.ts";
import { ProblemSchema, problem } from "./problem.ts";
import { registerActivity } from "./routes/activity.ts";
import { registerAdminClients } from "./routes/admin-clients.ts";
import { registerAgentDocs } from "./routes/agent-docs.ts";
import { registerAgents } from "./routes/agents.ts";
import { registerAlerts } from "./routes/alerts.ts";
import { registerAlibis } from "./routes/alibis.ts";
import { registerAnonymousMandates } from "./routes/anonymous-mandates.ts";
import { registerBonds } from "./routes/bonds.ts";
import { registerCardWebhooks } from "./routes/card-webhooks.ts";
import { registerChannel3Webhook } from "./routes/channel3-webhook.ts";
import { registerChargebacks } from "./routes/chargebacks.ts";
import { type CompileSources, registerCompile } from "./routes/compile.ts";
import { registerConnections } from "./routes/connections.ts";
import { registerCountersign } from "./routes/countersign.ts";
import { registerDisputes } from "./routes/disputes.ts";
import { registerEmbed } from "./routes/embed.ts";
import { noFraming, registerEmbedPage } from "./routes/embed-page.ts";
import { registerEmbedSigning } from "./routes/embed-signing.ts";
import { registerEngineCapabilities } from "./routes/engine-capabilities.ts";
import { registerEngineProofs } from "./routes/engine-proofs.ts";
import { registerEvents } from "./routes/events.ts";
import { registerEvidence } from "./routes/evidence.ts";
import { registerFeedback } from "./routes/feedback.ts";
import { registerFx } from "./routes/fx.ts";
import { registerGrades } from "./routes/grades.ts";
import { registerHealth } from "./routes/health.ts";
import { registerHold } from "./routes/hold.ts";
import { registerJudge } from "./routes/judge.ts";
import { registerLogBonds } from "./routes/log-bonds.ts";
import { registerMandateRequests } from "./routes/mandate-requests.ts";
import { registerMandates } from "./routes/mandates.ts";
import { registerMerchantAssistant } from "./routes/merchant-assistant.ts";
import { registerMerchantConsole } from "./routes/merchant-console.ts";
import { registerMerchantsPayout } from "./routes/merchants-payout.ts";
import { registerMerchantsSettlement } from "./routes/merchants-settlement.ts";
import { registerOAuthConsent } from "./routes/oauth-consent.ts";
import { registerObservations } from "./routes/observations.ts";
import { registerOperatorConsole } from "./routes/operator-console.ts";
import { registerOperators } from "./routes/operators.ts";
import { registerPasskeys } from "./routes/passkeys.ts";
import { registerPayPalWallet } from "./routes/paypal-wallet.ts";
import { registerPayPalWebhook } from "./routes/paypal-webhook.ts";
import { registerPurchaseHolds } from "./routes/purchase-holds.ts";
import { registerPurchaseTracking } from "./routes/purchase-tracking.ts";
import { registerPurchases } from "./routes/purchases.ts";
import { registerRedTeam } from "./routes/redteam.ts";
import { registerRevoke } from "./routes/revoke.ts";
import { registerStatus } from "./routes/status.ts";
import { registerStatusList } from "./routes/status-list.ts";
import { registerTee } from "./routes/tee.ts";
import { registerTimestamps } from "./routes/timestamps.ts";
import { registerTransactions } from "./routes/transactions.ts";
import { registerValidations } from "./routes/validations.ts";
import { registerWebFacts } from "./routes/web-facts.ts";
import type { TeeConfig } from "./tee/signers.ts";
import type { StampWorker } from "./timestamps/worker.ts";

/**
 * POST routes that stream their response, that read, or that an RFC 8628 client polls without an
 * `Idempotency-Key`: none changes anything a retry repeats. Embed tokens and sessions are never
 * stored for a replay; declining is a compare-and-set on a pending request. Mail clients post the
 * RFC 8058 one-click unsubscribe with no header of ours, and it is idempotent.
 */
const STREAMED_POSTS =
  /^\/v1\/(merchants\/[^/]+\/assistant|operators\/[^/]+\/(coverages\/rows|grid-query)|connections\/token|connections\/embed|embed\/(sessions|deny)|alerts\/unsubscribe)$/;

/**
 * The public reads the verifier makes: an Alibi when it is public, an Alibi's receipt, a leaf's
 * timestamps, a mandate's C3 proof, a purchase's engine proof and the registered-user roots.
 */
const PUBLIC_READS =
  /^\/v1\/(alibis\/[0-7][0-9A-HJKMNP-TV-Z]{25}|alibis\/[^/]+\/receipt|timestamps\/[^/]+|anonymous-mandates\/[^/]+|anonymous-purchases\/[^/]+|engine-proofs\/[^/]+|user-set\/roots\/[^/]+)$/;

/** Public operations beyond PUBLIC_READS that the documentation's try-it calls. */
const DOCS_CALLS = /^\/v1\/(live-purchases|log\/bonds|alibis\/verify)$/;

export interface Deps {
  db: Db;
  kv: RedisClientType;
  log: Logger;
  /** Better Auth instance served at `/api/auth/*`. */
  auth?: Auth;
  /** Browser origin allowed to call `/api/auth/*` with credentials; where mandates are signed. */
  appOrigin?: string;
  /** The public origin of this API, where Better Auth issues tokens; `/mcp` is served with it. */
  authBaseUrl?: string;
  /** The store MCP clients price carts on; `https://store.keelson.finance` by default. */
  storeOrigin?: string;
  /** Lets a Judge Mode session past the daily cap over every address; unset, no invite does. */
  judgeInvite?: string | undefined;
  /**
   * Keelson's hosted operator: the operator MCP tool calls act for when they name none, and the
   * one an app acting for a user goes through when it has no operator of its own.
   */
  demoAgentId?: bigint | undefined;
  /**
   * The hosted operator's private `cnf` key; the API closes delegated apps' mandates of that
   * operator with it, and nothing else (see `delegated.ts`). Their countersigns answer 503 without it.
   */
  hostedAgentKey?: CryptoKey;
  /** What the hosted operator's bond backs for apps it does not know; uncapped without it. */
  hostedCaps?: HostedCaps;
  /** Browser origin of the public verifier, allowed to read public Alibis, receipts and timestamps without credentials. */
  verifyOrigin?: string;
  /** Browser origin of the documentation, whose try-it calls the operations anyone may call, without credentials. */
  docsOrigin?: string;
  /** Reads the anchor and signer registry for `POST /v1/alibis/verify`; it verifies offline without it. */
  alibiChain?: ChainReader;
  /** WebAuthn RP ID that mandate signatures must be scoped to; defaults to `keelson.finance`. */
  passkeyRpId?: string | undefined;
  /** Resolves `c.var.principal`; runs before idempotency so keys are scoped per principal. */
  authenticate?: MiddlewareHandler;
  /** Handler deadline in milliseconds; must stay below the idempotency lock lifetime. */
  requestTimeoutMs?: number;
  rateLimit?: RateLimitOptions;
  /** The operator and TEE inputs of a compiled mandate; compiling answers 503 without them. */
  compileSources?: CompileSources;
  /** The Anthropic client compiles use; compiling answers 503 without it. */
  anthropic?: Anthropic;
  /** The two TEE legs; mandates are issued and carts countersigned through them. */
  tee?: TeeConfig;
  /** The Alibi log's private write listener; purchases are logged through it. */
  tlog?: LogConfig;
  /** The age identity that opens `.original` evidence items for an arbiter. */
  evidenceIdentity?: string;
  /** The TLSNotary prover service's base URL; WebFacts answer 503 without it. */
  prover?: string;
  /** Channel3 product lookups; observing answers 503 without them. */
  channel3?: Channel3Lookup;
  /** The `whsec_` secret of the Channel3 webhook endpoint; the webhook answers 503 without it. */
  channel3WebhookSecret?: string;
  /** Stamps queued hashes with RFC 3161 tokens; queued rows wait for the sweeper without it. */
  stamps?: StampWorker;
  /** The chains whose ERC-8004 registries and Keelson contracts are read; their routes answer 503 without them. */
  chains?: ChainReaders;
  /** Sends Keelson's contract calls and pays their gas; the gasless routes answer 503 without it. */
  relayer?: Relayer;
  /** The operators whose `Coverage` Keelson signs; their purchases fail before coverage without it. */
  operators?: OperatorSigners;
  /** PayPal orders and payments; the hold routes answer 503 without it. */
  paypal?: PayPalDeps;
  /** The webhook PayPal delivers to; the PayPal webhook answers 503 without it. */
  paypalWebhook?: { webhookId: string; certs: CertStore; now?: () => Date };
  /**
   * The card issuer of card purchases and the secrets it signs its real-time authorization
   * requests and its events with; card purchases fail before logging without it.
   */
  cards?: {
    issuer: CardIssuer;
    asaSecret?: string | undefined;
    webhookSecret?: string | undefined;
  };
  /** Applies stored PayPal events; woken when a delivery is stored. */
  paypalEvents?: { wake(): void };
  /**
   * Starts the evaluation of a dispute PayPal reported, keyed by its status, stage and
   * response due date (`revision`); disputes stay `OPEN` without it.
   */
  startDisputeWorkflow?: (disputeId: string, revision: string) => Promise<void>;
  /** The address that signs each merchant's settlement choices; its settlement address by default. */
  merchantSigners?: Readonly<Record<string, Address>>;
  /**
   * Proves C3 for a stored mandate under its commitment salt, off the request; mandates carry
   * no C3 proof without it.
   */
  proveAnonymousMandate?: (mandateId: string, salt: string) => Promise<void>;
  /**
   * Composes a logged purchase's C1 proof with its mandate's C3 proof, off the request; purchases
   * carry no composed proof without it.
   */
  proveAnonymousPurchase?: (purchaseId: string) => Promise<void>;
  /** Aborting it ends every open event stream so the server can close. */
  shutdown?: AbortSignal;
  /** The markup of the app's embedded approval page; `/embed/approve` is not served without it. */
  embedPage?: () => Promise<string>;
  /** Sends phone and email alerts; nothing is sent without it and the alert routes answer 503. */
  notifier?: Notifier;
}

/**
 * The `info` object of the OpenAPI document.
 * @internal
 */
export const apiInfo = { title: "Keelson API", version: "0.0.0" } as const;

const authServer = `${apiAudience}/api/auth`;

/**
 * Documents on each route the security its guard enforces: OAuth 2.1 client credentials for an
 * operator's agent, the authorization code grant with PKCE for an app acting for a user, or the
 * app's session cookie. `openapi` drops a route's middleware before it registers the route.
 */
function documentSecurity(app: OpenAPIHono): void {
  const register = app.openapi;
  app.openapi = ((route, handler, hook) => {
    const guards = [route.middleware ?? []].flat() as MiddlewareHandler[];
    const security = route.security ?? guards.map(securityOf).find((s) => s !== undefined);
    return register(security ? { ...route, security } : route, handler, hook);
  }) as typeof app.openapi;
  app.openAPIRegistry.registerComponent("securitySchemes", "oauth2", {
    type: "oauth2",
    description:
      "OAuth 2.1. An operator's agent uses client credentials; an app acting for a user uses the authorization code grant with PKCE (S256). Every token is requested for the resource `https://api.keelson.finance` (RFC 8707).",
    flows: {
      clientCredentials: { tokenUrl: `${authServer}/oauth2/token`, scopes: SCOPE_DESCRIPTIONS },
      authorizationCode: {
        authorizationUrl: `${authServer}/oauth2/authorize`,
        tokenUrl: `${authServer}/oauth2/token`,
        refreshUrl: `${authServer}/oauth2/token`,
        scopes: SCOPE_DESCRIPTIONS,
      },
    },
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "session", {
    type: "apiKey",
    in: "cookie",
    name: "__Secure-better-auth.session_token",
    description: "The session of a user signed in to the Keelson app.",
  });
}

/**
 * The OpenAPI 3.1 document of an app {@link createApp} built.
 *
 * @internal
 */
export function openApiDocument(app: OpenAPIHono): ReturnType<OpenAPIHono["getOpenAPI31Document"]> {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: apiInfo,
    servers: [{ url: apiAudience, description: "Keelson's API, on the PayPal sandbox" }],
  });
}

export function createApp(deps: Deps): OpenAPIHono {
  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        return problem(
          c,
          422,
          "validation-failed",
          "Validation failed",
          "The request is invalid.",
          {
            errors: result.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        );
      }
    },
  });
  documentSecurity(app);

  app.use(httpInstrumentationMiddleware());
  app.use(requestId({ generator: () => ulid() }));
  app.use(requestLogger(deps.log));
  app.use(noFraming);
  // The app calls the API cross-origin with its session cookie; preflights end here, before
  // authentication, rate limiting and idempotency.
  const appCors = deps.appOrigin
    ? cors({
        origin: deps.appOrigin,
        credentials: true,
        allowHeaders: ["content-type", "idempotency-key", "keelson-device"],
        exposeHeaders: [
          "location",
          "idempotent-replayed",
          "keelson-model",
          "x-keelson-pdf-signature",
        ],
      })
    : undefined;
  // The verifier reads only public receipts, timestamps and public Alibis, never with credentials,
  // so a bundle only its user or operator may read is never sent to it.
  const receiptCors = deps.verifyOrigin
    ? cors({ origin: deps.verifyOrigin, allowMethods: ["GET"], allowHeaders: ["accept"] })
    : undefined;
  // The documentation's try-it calls only operations that need no credentials.
  const docsCors = deps.docsOrigin
    ? cors({
        origin: deps.docsOrigin,
        allowMethods: ["GET", "POST"],
        allowHeaders: ["content-type", "idempotency-key", "accept"],
      })
    : undefined;
  const fromDocs = (c: Context) =>
    docsCors !== undefined && c.req.header("origin") === deps.docsOrigin;
  // The app's status page reads the dependency report, and so does the documentation.
  if (appCors || docsCors) {
    app.use("/status", (c, next) => {
      if (docsCors && fromDocs(c)) return docsCors(c, next);
      return appCors ? appCors(c, next) : next();
    });
  }
  if (appCors || receiptCors || docsCors) {
    app.use("/v1/*", (c, next) => {
      if (
        docsCors &&
        fromDocs(c) &&
        (PUBLIC_READS.test(c.req.path) || DOCS_CALLS.test(c.req.path))
      ) {
        return docsCors(c, next);
      }
      if (
        receiptCors &&
        c.req.header("origin") === deps.verifyOrigin &&
        PUBLIC_READS.test(c.req.path)
      ) {
        return receiptCors(c, next);
      }
      return appCors ? appCors(c, next) : next();
    });
  }
  const tooLarge = (c: Context) => problem(c, 413, "payload-too-large", "Payload too large");
  const smallBody = bodyLimit({ maxSize: 1024 * 1024, onError: tooLarge });
  // A sealed evidence bundle carries the screenshot, MHTML and HAR with their originals.
  const evidenceBody = bodyLimit({ maxSize: 16 * 1024 * 1024, onError: tooLarge });
  app.use("/v1/*", (c, next) =>
    c.req.path === "/v1/evidence" ? evidenceBody(c, next) : smallBody(c, next),
  );
  if (deps.authenticate) app.use("/v1/*", deps.authenticate);
  // An upload is refused before its body is read or fingerprinted.
  app.on("POST", "/v1/evidence", requireClient(["evidence:write"]));
  app.use("/v1/*", rateLimit(deps.kv, deps.rateLimit));
  // A model turn streams and changes nothing a retry could repeat; a buffered replay would end the stream.
  const idempotent = idempotency(deps.kv, deps.log);
  app.use("/v1/*", (c, next) => (STREAMED_POSTS.test(c.req.path) ? next() : idempotent(c, next)));
  app.use(
    "/v1/*",
    timeout(deps.requestTimeoutMs ?? 30_000, (c) => {
      c.set("timedOut", true);
      return new HTTPException(504, { message: "The request took too long." });
    }),
  );
  app.openAPIRegistry.register("Problem", ProblemSchema);

  app.notFound((c) => problem(c, 404, "not-found", "Not found"));
  app.onError((err, c) => {
    if (err instanceof HTTPException && err.status === 400) {
      return problem(c, 400, "malformed-body", "Malformed body", err.message);
    }
    if (err instanceof HTTPException && err.status === 504) {
      return problem(c, 504, "timeout", "Request timed out", err.message);
    }
    if (err instanceof HTTPException) {
      return problem(
        c,
        err.status as ContentfulStatusCode,
        "http-error",
        "Request failed",
        err.message,
      );
    }
    if (
      err instanceof BaseError &&
      err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null
    ) {
      deps.log.warn({ err, requestId: c.get("requestId") }, "chain rpc unavailable");
      return problem(
        c,
        503,
        "chain-unavailable",
        "Chain unavailable",
        "The chain RPC did not answer.",
      );
    }
    deps.log.error({ err, requestId: c.get("requestId") }, "unhandled error");
    const detail = process.env.NODE_ENV === "production" ? undefined : err.message;
    return problem(c, 500, "internal", "Internal server error", detail);
  });

  if (deps.auth) {
    const { auth } = deps;
    if (deps.appOrigin) app.use("/api/auth/*", cors({ origin: deps.appOrigin, credentials: true }));
    app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
    if (deps.appOrigin) registerAdminClients(app, auth, deps.appOrigin);
  }
  if (deps.authenticate) {
    registerMcp(
      app,
      { ...deps, authenticate: deps.authenticate },
      rateLimit(deps.kv, deps.rateLimit),
    );
  }
  registerContext(app, rateLimit(deps.kv, { ...deps.rateLimit, name: "context" }));
  registerHealth(app);
  registerEngineCapabilities(app, deps);
  registerStatusList(app, deps);
  registerAgentDocs(app);
  registerStatus(app, deps);
  registerEvents(app, deps);
  registerMandates(app, deps);
  registerHold(app, deps);
  registerPayPalWallet(app, deps);
  registerPurchaseHolds(app, deps);
  registerRevoke(app, deps);
  registerConnections(app, deps);
  registerMandateRequests(app, deps);
  registerEmbed(app, deps);
  registerEmbedSigning(app, deps);
  if (deps.embedPage) registerEmbedPage(app, deps, deps.embedPage);
  registerAgents(app, deps);
  registerActivity(app, deps);
  registerAlerts(app, deps);
  registerOAuthConsent(app, deps);
  registerCompile(app, deps);
  registerCountersign(app, deps);
  registerPurchases(app, deps);
  registerEvidence(app, deps);
  registerObservations(app, deps);
  registerFx(app, deps);
  registerWebFacts(app, deps);
  registerChannel3Webhook(app, deps);
  registerPayPalWebhook(app, deps);
  registerCardWebhooks(app, deps);
  registerChargebacks(app, deps);
  registerTee(app, deps);
  registerTimestamps(app, deps);
  registerAlibis(app, deps);
  registerAnonymousMandates(app, deps);
  registerEngineProofs(app, deps);
  registerDisputes(app, deps);
  registerPasskeys(app, deps);
  registerOperators(app, deps);
  registerGrades(app, deps);
  registerFeedback(app, deps);
  registerValidations(app, deps);
  registerBonds(app, deps);
  registerLogBonds(app, deps);
  registerMerchantsPayout(app, deps);
  registerMerchantsSettlement(app, deps);
  registerMerchantConsole(app, deps);
  registerMerchantAssistant(app, deps);
  registerOperatorConsole(app, deps);
  registerPurchaseTracking(app, deps);
  registerTransactions(app, deps);
  registerRedTeam(app, deps);
  registerJudge(app, deps);
  app.get("/openapi.json", (c) => c.json(openApiDocument(app)));
  return app;
}
