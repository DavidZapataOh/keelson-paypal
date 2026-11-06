import { isAPIError } from "better-auth/api";
import { requestToResourceInput, verifyAccessTokenRequest } from "better-auth/oauth2";
import type { Context, MiddlewareHandler } from "hono";
import { type Auth, apiAudience } from "../auth.ts";
import { problem } from "../problem.ts";

declare module "hono" {
  interface ContextVariableMap {
    invalidToken: boolean | undefined;
  }
}

/**
 * Resolves `c.var.principal` from a provider-issued access token or, when no `Authorization`
 * header is sent, from a session cookie. Never rejects: route guards decide what a missing
 * principal or an invalid token means.
 */
export function authenticate(auth: Auth, baseURL: string): MiddlewareHandler {
  const issuer = `${baseURL.replace(/\/$/, "")}/api/auth`;
  const jwksUrl = `${issuer}/jwks`;
  return async (c, next) => {
    if (c.req.header("authorization")) {
      try {
        const payload = await verifyAccessTokenRequest(requestToResourceInput(c.req.raw), {
          jwksUrl,
          verifyOptions: { issuer, audience: apiAudience, typ: "at+jwt", requiredClaims: ["azp"] },
        });
        c.set("principal", {
          kind: "client",
          subject: payload.azp as string,
          scopes: typeof payload.scope === "string" ? payload.scope.split(" ") : [],
        });
      } catch (err) {
        if (!isAPIError(err)) throw err;
        c.set("invalidToken", true);
      }
    } else {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session) c.set("principal", { kind: "user", subject: session.user.id });
    }
    await next();
  };
}

function invalidToken(c: Context): Response {
  c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
  return problem(
    c,
    401,
    "invalid-token",
    "Invalid token",
    "The access token is invalid or expired.",
  );
}

/**
 * Admits only OAuth clients whose access token carries every scope in `scopes`.
 * @internal
 */
export function requireClient(scopes: string[]): MiddlewareHandler {
  return async (c, next) => {
    if (c.var.invalidToken) return invalidToken(c);
    const principal = c.var.principal;
    if (!principal) {
      c.header("WWW-Authenticate", "Bearer");
      return problem(c, 401, "unauthorized", "Unauthorized", "A valid access token is required.");
    }
    const granted = new Set(principal.kind === "client" ? principal.scopes : []);
    const missing = scopes.filter((scope) => !granted.has(scope));
    if (missing.length > 0) {
      c.header(
        "WWW-Authenticate",
        `Bearer error="insufficient_scope", scope="${scopes.join(" ")}"`,
      );
      return problem(
        c,
        403,
        "insufficient-scope",
        "Insufficient scope",
        `The access token lacks ${missing.join(", ")}.`,
      );
    }
    await next();
  };
}

/** Admits only signed-in users. */
export function requireSession(): MiddlewareHandler {
  return async (c, next) => {
    if (c.var.invalidToken) return invalidToken(c);
    const principal = c.var.principal;
    if (!principal) {
      return problem(c, 401, "unauthorized", "Unauthorized", "A session is required.");
    }
    if (principal.kind !== "user") {
      return problem(c, 403, "insufficient-scope", "Insufficient scope", "A session is required.");
    }
    await next();
  };
}

/** Admits any signed-in user or OAuth client. */
export function requirePrincipal(): MiddlewareHandler {
  return async (c, next) => {
    if (c.var.invalidToken) return invalidToken(c);
    if (!c.var.principal) {
      c.header("WWW-Authenticate", "Bearer");
      return problem(
        c,
        401,
        "unauthorized",
        "Unauthorized",
        "A session or access token is required.",
      );
    }
    await next();
  };
}
