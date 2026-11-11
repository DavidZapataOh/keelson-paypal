import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { eq, oauthClient, operators } from "@keelson/db";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import type { Auth } from "../auth.ts";
import { requireSession } from "../middleware/auth.ts";
import { notify, requestAlert } from "../notify/notifier.ts";
import type { Principal } from "../principal.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { ConnectionRequest, invalidLimits, storeRequest } from "./connections.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

/**
 * The type of the `authorization_details` entry (in RFC 9396's format, carried as a plain
 * authorization request parameter: it is shown on the consent page, not bound to the token) an MCP
 * client asks for spending limits with.
 */
const MANDATE_DETAILS_TYPE = "keelson_mandate";

const SignedQuery = z
  .object({
    oauthQuery: z.string().min(1).max(8192).openapi({
      description: "The signed query the authorization server sent the consent page.",
    }),
  })
  .openapi("SignedOAuthQuery");

const Consent = z
  .object({
    client: z.object({
      id: z.string(),
      name: z.string(),
      uri: z.string().nullable(),
      verified: z.boolean().openapi({
        description:
          "Whether the client is bound to a registered agent operator; a dynamically registered client never is until its operator links it.",
      }),
    }),
    agent: z
      .object({
        agentId: z.string(),
        operator: z.string(),
        hosted: z.boolean().openapi({
          description:
            "Whether the client has no operator of its own and acts through Keelson's hosted operator, whose bond covers its purchases.",
        }),
      })
      .nullable()
      .openapi({ description: "The operator the client's mandates name, if it can be given any." }),
    scopes: z.array(z.string()),
    spending: ConnectionRequest.nullable().openapi({
      description: `The limits the client asks for in \`authorization_details\` of type \`${MANDATE_DETAILS_TYPE}\`.`,
    }),
    spendingError: z.string().nullable().openapi({
      description: "Why the requested spending cannot be approved, when it cannot.",
    }),
  })
  .openapi("OAuthConsent");

const read = createRoute({
  method: "post",
  path: "/v1/oauth/consent",
  tags: ["oauth"],
  summary: "Read a consent request",
  description:
    "What the consent page shows: the client, whether it is verified, the scopes and the spending limits it asks for. The signed query is verified first.",
  middleware: [requireSession()],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: SignedQuery } } },
  },
  responses: {
    200: { description: "The request", content: { "application/json": { schema: Consent } } },
    400: { description: "The signed query is invalid or expired", content: problemContent },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such client", content: problemContent },
  },
});

const connect = createRoute({
  method: "post",
  path: "/v1/oauth/consent/connection",
  tags: ["oauth"],
  summary: "Turn a consent's spending request into an approval",
  description:
    "Stores the spending the client asked for as an agent request and returns its user code, for the user to approve with a passkey on the approval page before consenting.",
  middleware: [requireSession()],
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    body: { required: true, content: { "application/json": { schema: SignedQuery } } },
  },
  responses: {
    201: {
      description: "Open the approval page with this code",
      content: { "application/json": { schema: z.object({ userCode: z.string() }) } },
    },
    400: { description: "The signed query is invalid or expired", content: problemContent },
    401: { description: "Not signed in", content: problemContent },
    404: { description: "No such client", content: problemContent },
    422: { description: "The client cannot ask for spending", content: problemContent },
  },
});

interface Parsed {
  client: typeof oauthClient.$inferSelect;
  /** The client's own operator, or else the hosted one. */
  operator: typeof operators.$inferSelect | undefined;
  hosted: boolean;
  scopes: string[];
  spending: z.infer<typeof ConnectionRequest> | null;
  spendingError: string | null;
}

/** The spending entry of `authorization_details`, if the client sent one. */
function spendingOf(raw: string | null): {
  spending: z.infer<typeof ConnectionRequest> | null;
  error: string | null;
} {
  if (raw === null) return { spending: null, error: null };
  let details: unknown;
  try {
    details = JSON.parse(raw);
  } catch {
    return { spending: null, error: "authorization_details is not JSON." };
  }
  const entry = Array.isArray(details)
    ? details.find((d) => (d as { type?: unknown })?.type === MANDATE_DETAILS_TYPE)
    : undefined;
  if (!entry) return { spending: null, error: null };
  const parsed = ConnectionRequest.safeParse(entry);
  if (!parsed.success) {
    return {
      spending: null,
      error: `The spending request is invalid: ${parsed.error.issues.map((i) => i.path.join(".") || i.message).join(", ")}.`,
    };
  }
  const invalid = invalidLimits(parsed.data.limits);
  return invalid ? { spending: null, error: invalid } : { spending: parsed.data, error: null };
}

export function registerOAuthConsent(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "auth" | "demoAgentId" | "notifier">,
): void {
  const { db, auth } = deps;
  if (!auth) return;

  async function parse(c: Context, auth: Auth, oauthQuery: string): Promise<Parsed | Response> {
    const { secret } = await auth.$context;
    if (!(await verifyOAuthQueryParams(oauthQuery, secret))) {
      return problem(
        c,
        400,
        "invalid-oauth-query",
        "Invalid consent request",
        "The signed query is invalid or expired.",
      );
    }
    const query = new URLSearchParams(oauthQuery);
    const clientId = query.get("client_id") ?? "";
    const [client] = await db.select().from(oauthClient).where(eq(oauthClient.clientId, clientId));
    if (!client || client.disabled) return problem(c, 404, "not-found", "Not found");
    const [own] = await db.select().from(operators).where(eq(operators.clientId, clientId));
    const [hosted] =
      own || deps.demoAgentId === undefined
        ? []
        : await db.select().from(operators).where(eq(operators.agentId, deps.demoAgentId));
    const operator = own ?? hosted;
    const { spending, error } = spendingOf(query.get("authorization_details"));
    return {
      client,
      operator,
      hosted: !own && hosted !== undefined,
      scopes: (query.get("scope") ?? "").split(" ").filter(Boolean),
      spending,
      spendingError:
        error ??
        (spending && !operator
          ? "No registered agent operator can answer for this app, so it cannot be given spending limits."
          : null),
    };
  }

  app.openapi(read, async (c) => {
    const parsed = await parse(c, auth, c.req.valid("json").oauthQuery);
    if (parsed instanceof Response) return parsed as never;
    const { client, operator, hosted } = parsed;
    return c.json(
      {
        client: {
          id: client.clientId,
          name: client.name ?? client.clientId,
          uri: client.uri,
          verified: operator !== undefined && !hosted,
        },
        agent: operator
          ? { agentId: operator.agentId.toString(), operator: operator.name, hosted }
          : null,
        scopes: parsed.scopes,
        spending: parsed.spendingError ? null : parsed.spending,
        spendingError: parsed.spendingError,
      },
      200,
    );
  });

  app.openapi(connect, async (c) => {
    const parsed = await parse(c, auth, c.req.valid("json").oauthQuery);
    if (parsed instanceof Response) return parsed as never;
    if (!parsed.spending || !parsed.operator) {
      return problem(
        c,
        422,
        "no-spending-request",
        "No spending request",
        parsed.spendingError ?? "The client asked for no spending limits.",
      );
    }
    const { id, userCode } = await storeRequest(deps, {
      clientId: parsed.client.clientId,
      operatorAgentId: parsed.operator.agentId,
      name: parsed.spending.name,
      reason: parsed.spending.reason,
      limits: parsed.spending.limits,
      // Bound to the user consenting: only they may approve it.
      userId: (c.get("principal") as Principal).subject,
    });
    notify(deps.notifier, (n) => requestAlert(n, id));
    return c.json({ userCode }, 201);
  });
}
