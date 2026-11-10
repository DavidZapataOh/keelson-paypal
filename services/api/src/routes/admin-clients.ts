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
    401: { description: "No session", content: problemContent },
    403: { description: "The session's user is not an admin", content: problemContent },
    404: { description: "No such client", content: problemContent },
    422: { description: "Invalid scopes", content: problemContent },
  },
});

export function registerAdminClients(app: OpenAPIHono, auth: Auth): void {
  app.openapi(route, async (c) => {
    // The session cookie only: a bearer token never stands for an admin here.
    const headers = new Headers(c.req.raw.headers);
    headers.delete("authorization");
    const session = await auth.api.getSession({ headers });
    if (!session) {
      return problem(c, 401, "unauthorized", "Unauthorized", "Sign in to manage OAuth clients.");
    }
    if (session.user.role !== "admin") {
      return problem(c, 403, "forbidden", "Forbidden", "Only an admin manages OAuth clients.");
    }
    const { clientId } = c.req.valid("param");
    const { scopes } = c.req.valid("json");
    try {
      const client = await auth.api.adminUpdateOAuthClient({
        headers,
        body: {
          client_id: clientId,
          update: { grant_types: ["client_credentials"], client_credentials_scopes: scopes },
        },
      });
      return c.json({ clientId, scopes: [...(client.client_credentials_scopes ?? [])] }, 200);
    } catch (err) {
      if (!isAPIError(err)) throw err;
      if (err.status === "NOT_FOUND") {
        return problem(c, 404, "not-found", "Not found", "No OAuth client with this id.");
      }
      return problem(c, 422, "invalid-client-update", "Invalid update", err.message);
    }
  });
}
