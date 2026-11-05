import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const problemBase = "https://api.keelson.finance/problems/";

export const ProblemSchema = z
  .object({
    type: z.url(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string(),
  })
  .catchall(z.unknown())
  .openapi("Problem");

/** Builds an RFC 9457 `application/problem+json` response. */
export function problem(
  c: Context,
  status: ContentfulStatusCode,
  slug: string,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
): Response {
  const body = {
    type: `${problemBase}${slug}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: c.req.path,
    ...extra,
  };
  return c.newResponse(JSON.stringify(body), status, {
    "content-type": "application/problem+json",
  });
}
