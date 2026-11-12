import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Cart } from "@keelson/core";
import type { Context } from "hono";
import type { Deps } from "../app.ts";
import { apiAudience } from "../auth.ts";
import { requireAgent } from "../middleware/auth.ts";
import { ProblemSchema } from "../problem.ts";
import { CartSchema } from "./countersign.ts";
import { checkCart, clientMandate } from "./mandate-requests.ts";

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const Subject = z.object({ type: z.literal("agent"), id: z.string().min(1) });
const Action = z.object({ name: z.literal("purchase") });
const Resource = z.object({
  type: z.literal("mandate"),
  id: z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  properties: z.object({ cart: CartSchema }),
});

const Evaluation = z
  .object({ subject: Subject, action: Action, resource: Resource })
  .openapi("AccessEvaluationRequest");

const Decision = z
  .object({
    decision: z.boolean(),
    context: z.object({
      binding: z.literal(false).openapi({
        description:
          "A preview: only the TEE countersign (`POST /v1/countersign`) decides a purchase.",
      }),
      reason_admin: z.object({ en: z.string() }),
      checks: z.array(z.object({}).catchall(z.unknown())),
      blockers: z.array(z.object({}).catchall(z.unknown())),
    }),
  })
  .openapi("AccessEvaluationResponse");

/** One evaluation of a boxcar: each member it omits is the request's default (AuthZEN §7.1). */
const Item = z.object({
  subject: Subject.optional(),
  action: Action.optional(),
  resource: Resource.optional(),
});

const evaluation = createRoute({
  method: "post",
  path: "/access/v1/evaluation",
  operationId: "accessEvaluation",
  tags: ["mandates"],
  summary: "Preview a cart against a mandate (OpenID AuthZEN)",
  description:
    "The Access Evaluation API of OpenID AuthZEN 1.0: would this agent's purchase of this cart pass this mandate now? It answers from the same policy set the TEE legs run, as `POST /v1/mandates/{id}/check` does, and is never binding.",
  middleware: [requireAgent("purchases:write")],
  request: { body: { required: true, content: { "application/json": { schema: Evaluation } } } },
  responses: {
    200: { description: "The decision", content: { "application/json": { schema: Decision } } },
    401: { description: "No valid access token", content: problemContent },
  },
});

const evaluations = createRoute({
  method: "post",
  path: "/access/v1/evaluations",
  operationId: "accessEvaluations",
  tags: ["mandates"],
  summary: "Preview several carts (OpenID AuthZEN boxcar)",
  description:
    "Up to 20 evaluations in one request, in order. Each takes the request's `subject`, `action` and `resource` for any it omits.",
  middleware: [requireAgent("purchases:write")],
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: Item.extend({ evaluations: z.array(Item).min(1).max(20) }),
        },
      },
    },
  },
  responses: {
    200: {
      description: "The decisions, in order",
      content: { "application/json": { schema: z.object({ evaluations: z.array(Decision) }) } },
    },
    401: { description: "No valid access token", content: problemContent },
  },
});

type Request = z.infer<typeof Evaluation>;
type Answer = z.infer<typeof Decision>;

const deny = (en: string): Answer => ({
  decision: false,
  context: { binding: false, reason_admin: { en }, checks: [], blockers: [] },
});

/**
 * OpenID AuthZEN 1.0 over the cart check: Keelson as a policy decision point any policy-aware
 * platform can ask before it pays.
 * @see https://openid.net/specs/authorization-api-1_0.html
 */
export function registerAuthzen(app: OpenAPIHono, deps: Pick<Deps, "db" | "authBaseUrl">): void {
  const base = (deps.authBaseUrl ?? apiAudience).replace(/\/$/, "");
  app.get("/.well-known/authzen-configuration", (c) =>
    c.json(
      {
        policy_decision_point: base,
        access_evaluation_endpoint: `${base}/access/v1/evaluation`,
        access_evaluations_endpoint: `${base}/access/v1/evaluations`,
      },
      200,
      { "access-control-allow-origin": "*" },
    ),
  );

  async function evaluate(c: Context, r: Request): Promise<Answer> {
    // The same answer for an unknown mandate and another client's, so neither is disclosed.
    const mandate = await clientMandate(c, deps.db, r.resource.id);
    if (!mandate) return deny("No such mandate for this client.");
    if (mandate.operatorAgentId.toString() !== r.subject.id) {
      return deny(`The mandate names agent #${mandate.operatorAgentId}, not #${r.subject.id}.`);
    }
    const out = await checkCart(deps.db, mandate, r.resource.properties.cart as Cart);
    return {
      decision: out.canAttempt,
      context: {
        binding: false,
        reason_admin: {
          en: out.canAttempt
            ? "Every mandate field passes this cart."
            : out.blockers.map((b) => b.message).join(" "),
        },
        checks: out.checks,
        blockers: out.blockers,
      },
    };
  }

  app.openapi(evaluation, async (c) => c.json(await evaluate(c, c.req.valid("json")), 200));

  app.openapi(evaluations, async (c) => {
    const { evaluations: items, ...defaults } = c.req.valid("json");
    const requests = items.map((i) => ({ ...defaults, ...i }));
    const answers: Answer[] = [];
    for (const r of requests) {
      const full = Evaluation.safeParse(r);
      answers.push(
        full.success ? await evaluate(c, full.data) : deny("The evaluation lacks a member."),
      );
    }
    return c.json({ evaluations: answers }, 200);
  });
}
