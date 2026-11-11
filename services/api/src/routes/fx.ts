import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { CURRENCIES, type CurrencyCode } from "@keelson/core";
import type { Deps } from "../app.ts";
import { referenceRates } from "../fx.ts";
import { requireClient } from "../middleware/auth.ts";
import { ProblemSchema, problem } from "../problem.ts";

const Reference = z
  .object({
    v: z.literal("keelson.fx_reference/1"),
    provider: z.string(),
    source: z.string(),
    base: z.string(),
    as_of: z.string().openapi({ description: "When the provider last updated the rates." }),
    fetched_at: z.string(),
    rates: z.record(z.string(), z.string()).openapi({
      description: "Units of each currency one unit of `base` buys, as decimal strings.",
    }),
  })
  .openapi("FxReference");

const route = createRoute({
  method: "get",
  path: "/v1/fx/reference/{base}",
  operationId: "getFxReference",
  tags: ["purchases"],
  summary: "Reference exchange rates",
  description:
    "Mid-market rates from the merchant's currency to every other one, from ExchangeRate-API (Rates By Exchange Rate API, https://www.exchangerate-api.com), at most 48 hours old. The agent binds them into a purchase's evidence as an `api.fx_reference` item, `commitReference` of this answer, which a countersign accepts only for references the API issued in the last 6 hours. The pay-click gate checks the rate PayPal converts the charge at against them, within the mandate's `fx.max_spread_bps`.",
  middleware: [requireClient(["countersign:write"])],
  request: {
    params: z.object({
      base: z.enum(Object.keys(CURRENCIES) as [CurrencyCode, ...CurrencyCode[]]),
    }),
  },
  responses: {
    200: { description: "The rates", content: { "application/json": { schema: Reference } } },
    503: {
      description: "No current reference rates: a converted charge is then never paid",
      content: { "application/problem+json": { schema: ProblemSchema } },
    },
  },
});

export function registerFx(app: OpenAPIHono, deps: Pick<Deps, "kv">): void {
  app.openapi(route, async (c) => {
    const ref = await referenceRates(deps.kv, c.req.valid("param").base);
    if (!ref) {
      return problem(
        c,
        503,
        "fx-reference-unavailable",
        "Reference rates unavailable",
        "Keelson cannot get current reference exchange rates. A charge PayPal converts to the buyer's currency waits until it can.",
      );
    }
    return c.json(ref, 200);
  });
}
