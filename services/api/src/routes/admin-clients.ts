import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { isAPIError } from "better-auth/api";
import { type Auth, OAUTH_SCOPES } from "../auth.ts";
import { ProblemSchema, problem } from "../problem.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const Scopes = z
  .object({
    scopes: z.array(z.enum(OAUTH_SCOPES)).min(1).max(OAUTH_SCOPES.length),
  })
  .openapi("ClientCredentialsScopes");

const route = createRoute({
  method: "post",
  path: "/v1/admin/oauth-clients/{clientId}/client-credentials-scopes",
  tags: ["admin"],
  summary: "Set an OAuth client's client credentials scopes",
  description:
    "Sets the scopes an OAuth client may ask for with the client credentials grant, and turns that grant on. Only a signed-in user whose role is `admin` may, with the session cookie; an access token is not accepted.",
  request: {
    headers: z.object({ "idempotency-key": z.string().min(1).max(255) }),
    params: z.object({ clientId: z.string().min(1).max(128) }),
    body: { required: true, content: { "application/json": { schema: Scopes } } },
  },
  responses: {
    200: {
      description: "The scopes the client now has",
      content: {
        "application/json": {
          schema: z.object({ clientId: z.string(), scopes: z.array(z.string()) }),
        },
      },
    },
    401: { description: "No session, or a token was sent", content: problemContent },
    403: {
      description: "Not from the app's origin, or the session's user is not an admin",
      content: problemContent,
    },
    404: { description: "No such client", content: problemContent },
    422: { description: "Invalid scopes", content: problemContent },
  },
});

export function registerAdminClients(app: OpenAPIHono, auth: Auth, appOrigin: string): void {
  app.openapi(route, async (c) => {
    // Calling Better Auth from the server skips its own origin check, so the route makes it.
    if (c.req.header("origin") !== appOrigin) {
      return problem(c, 403, "forbidden", "Forbidden", "Manage OAuth clients from the app.");
    }
    // The session cookie only: a bearer token never stands for an admin here.
    if (c.req.header("authorization")) {
      return problem(c, 401, "unauthorized", "Unauthorized", "Use your session, not a token.");
    }
    const headers = new Headers(c.req.raw.headers);
    const session = await auth.api.getSession({ headers });
    if (!session) {
      return problem(c, 401, "unauthorized", "Unauthorized", "Sign in to manage OAuth clients.");
    }
    if (session.user.role !== "admin") {
      return problem(c, 403, "forbidden", "Forbidden", "Only an admin manages OAuth clients.");
    }
    const { clientId } = c.req.valid("param");
    const { scopes } = c.req.valid("json");
    // Scopes alone let an admin configure a client another user registered; the grant is added
    // only when the client lacks it.
    const update = (grant: boolean) =>
      auth.api.adminUpdateOAuthClient({
        headers,
        body: {
          client_id: clientId,
          update: {
            client_credentials_scopes: scopes,
            ...(grant ? { grant_types: ["client_credentials" as const] } : {}),
          },
        },
      });
    try {
      let client: Awaited<ReturnType<typeof update>>;
      try {
        client = await update(false);
      } catch (err) {
        if (!(isAPIError(err) && /client_credentials grant/.test(err.message))) throw err;
        client = await update(true);
      }
      return c.json({ clientId, scopes: [...(client.client_credentials_scopes ?? [])] }, 200);
    } catch (err) {
      if (!isAPIError(err)) throw err;
      if (err.status === "NOT_FOUND") {
        return problem(c, 404, "not-found", "Not found", "No OAuth client with this id.");
      }
      if (err.status === "UNAUTHORIZED" || err.status === "FORBIDDEN") {
        return problem(c, 403, "forbidden", "Forbidden", "The client cannot be configured.");
      }
      if (err.status === "BAD_REQUEST") {
        return problem(
          c,
          422,
          "invalid-client-update",
          "Invalid update",
          "The scopes cannot be set on this client.",
        );
      }
      throw err;
    }
  });
}
