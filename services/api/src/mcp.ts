import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";
import type { OpenAPIHono } from "@hono/zod-openapi";
import { createKeelsonServer } from "@keelson/mcp";
import {
  type AuthInfo,
  createMcpHandler,
  hostHeaderValidationResponse,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
} from "@modelcontextprotocol/server";
import { isAPIError } from "better-auth/api";
import { verifyBearerToken } from "better-auth/oauth2";
import { bodyLimit } from "hono/body-limit";
import type { Deps } from "./app.ts";
import { apiAudience, tokenScopes } from "./auth.ts";

/**
 * Keelson's MCP server on Streamable HTTP at `/mcp`, stateless: one server per request, built for
 * the caller's access token. This API is the OAuth protected resource (RFC 9728); its tools call
 * the API in process with the caller's own token, so every route keeps its own checks.
 */
export function registerMcp(
  app: OpenAPIHono,
  deps: Pick<Deps, "auth" | "authBaseUrl" | "appOrigin" | "storeOrigin" | "demoAgentId"> &
    Pick<Required<Deps>, "authenticate">,
  limit: Parameters<OpenAPIHono["use"]>[1],
): void {
  const { auth, authBaseUrl } = deps;
  if (!auth || !authBaseUrl) return;
  const base = authBaseUrl.replace(/\/$/, "");
  const issuer = `${base}/api/auth`;
  const metadataUrl = `${base}/.well-known/oauth-protected-resource`;
  const hostname = new URL(base).hostname;

  // No `scopes_supported`: MCP clients would request every listed scope, and a client is granted
  // only the ones its registration holds. Each tool challenges for its own (`insufficient_scope`).
  app.get("/.well-known/oauth-protected-resource", (c) =>
    c.json(
      {
        resource: apiAudience,
        authorization_servers: [issuer],
        bearer_methods_supported: ["header"],
        resource_name: "Keelson",
        resource_documentation: "https://keelson.finance",
      },
      200,
      { "access-control-allow-origin": "*" },
    ),
  );
  const asMetadata = oauthProviderAuthServerMetadata(auth, {
    headers: { "access-control-allow-origin": "*" },
  });
  app.get("/.well-known/oauth-authorization-server/api/auth", (c) => asMetadata(c.req.raw));

  const gate = requireBearerAuth({
    verifier: {
      async verifyAccessToken(token): Promise<AuthInfo> {
        try {
          const payload = await verifyBearerToken(token, {
            jwksUrl: `${issuer}/jwks`,
            verifyOptions: {
              issuer,
              audience: apiAudience,
              typ: "at+jwt",
              requiredClaims: ["azp"],
            },
          });
          return {
            token,
            clientId: payload.azp as string,
            scopes: tokenScopes(payload),
            ...(payload.exp ? { expiresAt: payload.exp } : {}),
            resource: new URL(apiAudience),
          };
        } catch (err) {
          if (!isAPIError(err)) throw err;
          throw new OAuthError(
            OAuthErrorCode.InvalidToken,
            "The access token is invalid or expired.",
          );
        }
      },
    },
    resourceMetadataUrl: metadataUrl,
    expectedResource: new URL(apiAudience),
  });

  const handler = createMcpHandler(({ authInfo }) =>
    createKeelsonServer({
      keelson: {
        request(path, init) {
          const headers = new Headers(init.headers);
          headers.set("authorization", `Bearer ${authInfo?.token}`);
          return app.request(path, { ...init, headers });
        },
      },
      appOrigin: deps.appOrigin ?? "https://app.keelson.finance",
      storeOrigin: deps.storeOrigin ?? "https://store.keelson.finance",
      agentId: deps.demoAgentId,
      scoped: true,
    }),
  );

  // The largest call, `keelson.submit_evidence`, is about 100 KB.
  app.use(
    "/mcp",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ error: "payload too large" }, 413),
    }),
    deps.authenticate,
    limit,
  );
  app.all("/mcp", async (c) => {
    const req = c.req.raw;
    const refused =
      hostHeaderValidationResponse(req, [hostname]) ?? originValidationResponse(req, []);
    if (refused) return refused;
    const authInfo = await gate(req);
    if (authInfo instanceof Response) return authInfo;
    return handler.fetch(req, { authInfo });
  });
}
