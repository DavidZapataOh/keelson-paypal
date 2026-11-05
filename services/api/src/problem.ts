import { z } from "@hono/zod-openapi";
import type { Context, TypedResponse } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { JSONParsed } from "hono/utils/types";

const problemBase = "https://api.keelson.finance/problems/";

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

type ProblemBody = JSONParsed<z.infer<typeof ProblemSchema>>;

/** Builds an RFC 9457 `application/problem+json` response. */
export function problem<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  slug: string,
  title: string,
  detail?: string,
  extra?: Record<string, unknown>,
): Response & TypedResponse<ProblemBody, S, "json"> {
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
  }) as Response & TypedResponse<ProblemBody, S, "json">;
}
