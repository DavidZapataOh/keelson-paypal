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
import type { Auth } from "./auth.ts";
import type { ChainReaders } from "./chain/reader.ts";
import type { Channel3Lookup } from "./channel3/client.ts";
import type { LogConfig } from "./log/append.ts";
import { requestLogger } from "./logger.ts";
import { registerMcp } from "./mcp.ts";
import { requireClient } from "./middleware/auth.ts";
import { idempotency } from "./middleware/idempotency.ts";
import { type RateLimitOptions, rateLimit } from "./middleware/rate-limit.ts";
import type { OperatorSigners } from "./operators/signer.ts";
import type { PayPalDeps } from "./paypal.ts";
import { ProblemSchema, problem } from "./problem.ts";
import { registerAdminClients } from "./routes/admin-clients.ts";
import { registerAlibis } from "./routes/alibis.ts";
import { registerAnonymousMandates } from "./routes/anonymous-mandates.ts";
import { registerBonds } from "./routes/bonds.ts";
import { registerChannel3Webhook } from "./routes/channel3-webhook.ts";
import { type CompileSources, registerCompile } from "./routes/compile.ts";
import { registerCountersign } from "./routes/countersign.ts";
import { registerDisputes } from "./routes/disputes.ts";
import { registerEvents } from "./routes/events.ts";
import { registerEvidence } from "./routes/evidence.ts";
import { registerFeedback } from "./routes/feedback.ts";
import { registerGrades } from "./routes/grades.ts";
import { registerHealth } from "./routes/health.ts";
import { registerHold } from "./routes/hold.ts";
import { registerMandates } from "./routes/mandates.ts";
import { registerMerchantAssistant } from "./routes/merchant-assistant.ts";
import { registerMerchantConsole } from "./routes/merchant-console.ts";
import { registerMerchantsPayout } from "./routes/merchants-payout.ts";
import { registerMerchantsSettlement } from "./routes/merchants-settlement.ts";
import { registerObservations } from "./routes/observations.ts";
import { registerOperatorConsole } from "./routes/operator-console.ts";
import { registerOperators } from "./routes/operators.ts";
import { registerPasskeys } from "./routes/passkeys.ts";
import { registerPayPalWebhook } from "./routes/paypal-webhook.ts";
import { registerPurchaseHolds } from "./routes/purchase-holds.ts";
import { registerPurchaseTracking } from "./routes/purchase-tracking.ts";
import { registerPurchases } from "./routes/purchases.ts";
import { registerRedTeam } from "./routes/redteam.ts";
import { registerRevoke } from "./routes/revoke.ts";
import { registerStatus } from "./routes/status.ts";
import { registerTee } from "./routes/tee.ts";
import { registerTimestamps } from "./routes/timestamps.ts";
import { registerTransactions } from "./routes/transactions.ts";
import { registerValidations } from "./routes/validations.ts";
import type { TeeConfig } from "./tee/signers.ts";
import type { StampWorker } from "./timestamps/worker.ts";

/** POST routes that stream their response, or that read: neither changes anything a retry repeats. */
const STREAMED_POSTS =
  /^\/v1\/(merchants\/[^/]+\/assistant|operators\/[^/]+\/(coverages\/rows|grid-query))$/;

/**
 * The public reads the verifier makes: an Alibi's receipt, a leaf's timestamps, a mandate's C3
 * proof and the registered-user roots.
 */
const PUBLIC_READS =
  /^\/v1\/(alibis\/[^/]+\/receipt|timestamps\/[^/]+|anonymous-mandates\/[^/]+|user-set\/roots\/[^/]+)$/;

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
  /** The operator MCP tool calls act for when they name none. */
  demoAgentId?: bigint | undefined;
  /** Browser origin of the public verifier, allowed to read Alibi receipts and timestamps without credentials. */
  verifyOrigin?: string;
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
  /** Aborting it ends every open event stream so the server can close. */
  shutdown?: AbortSignal;
}

/**
 * The `info` object of the OpenAPI document.
 * @internal
 */
export const apiInfo = { title: "Keelson API", version: "0.0.0" } as const;

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

  app.use(httpInstrumentationMiddleware());
  app.use(requestId({ generator: () => ulid() }));
  app.use(requestLogger(deps.log));
  // The app calls the API cross-origin with its session cookie; preflights end here, before
  // authentication, rate limiting and idempotency.
  const appCors = deps.appOrigin
    ? cors({
        origin: deps.appOrigin,
        credentials: true,
        allowHeaders: ["content-type", "idempotency-key", "keelson-device"],
        exposeHeaders: ["location", "idempotent-replayed", "keelson-model"],
      })
    : undefined;
  // The verifier reads only public receipts and timestamps, and never with credentials.
  const receiptCors = deps.verifyOrigin
    ? cors({ origin: deps.verifyOrigin, allowMethods: ["GET"], allowHeaders: ["accept"] })
    : undefined;
  if (appCors || receiptCors) {
    app.use("/v1/*", (c, next) => {
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
  registerHealth(app);
  registerStatus(app, deps);
  registerEvents(app, deps);
  registerMandates(app, deps);
  registerHold(app, deps);
  registerPurchaseHolds(app, deps);
  registerRevoke(app, deps);
  registerCompile(app, deps);
  registerCountersign(app, deps);
  registerPurchases(app, deps);
  registerEvidence(app, deps);
  registerObservations(app, deps);
  registerChannel3Webhook(app, deps);
  registerPayPalWebhook(app, deps);
  registerTee(app, deps);
  registerTimestamps(app, deps);
  registerAlibis(app, deps);
  registerAnonymousMandates(app, deps);
  registerDisputes(app, deps);
  registerPasskeys(app, deps);
  registerOperators(app, deps);
  registerGrades(app, deps);
  registerFeedback(app, deps);
  registerValidations(app, deps);
  registerBonds(app, deps);
  registerMerchantsPayout(app, deps);
  registerMerchantsSettlement(app, deps);
  registerMerchantConsole(app, deps);
  registerMerchantAssistant(app, deps);
  registerOperatorConsole(app, deps);
  registerPurchaseTracking(app, deps);
  registerTransactions(app, deps);
  registerRedTeam(app, deps);
  app.get("/openapi.json", (c) =>
    c.json(app.getOpenAPI31Document({ openapi: "3.1.0", info: apiInfo })),
  );
  return app;
}
