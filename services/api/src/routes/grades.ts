import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { Deps } from "../app.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { type GradeResult, gradeOf } from "../risk.ts";

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;
/** Per instance; the API runs as a single instance. */
const MAX_STREAMS = 200;

const AgentId = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .openapi({ description: "The operator's ERC-8004 agent id, a decimal integer." });

const int = () => z.number().int();

const TrustGrade = z
  .object({
    v: z.literal("keelson.grade/1"),
    agentId: z.string(),
    grade: z.enum(["A", "B", "C", "D", "F"]).openapi({
      description:
        "From the one-sided 95 % credible upper bound of the incident rate: A ≤ 1 %, B ≤ 2 %, C ≤ 5 %, D ≤ 10 %, F above.",
    }),
    computedAt: z.string().openapi({ format: "date-time" }),
    calibration: z.object({
      id: z.string(),
      at: z.string().openapi({ format: "date-time" }),
      campaigns: z.array(z.string()).openapi({ description: "The red-team campaigns pooled." }),
      mu_ppm: int().openapi({ description: "The prior's mean, ASR × escape + amber." }),
      kappa: z.number().openapi({ description: "The prior's strength, by the method of moments." }),
    }),
    evidence: z.object({
      coverages: int(),
      incidents: z
        .object({
          total: int(),
          slashes: int().openapi({ description: "Paid from the operator's bond." }),
          pool: int().openapi({ description: "Paid from its `ViolationBondPool` deposit." }),
          uncollected: int().openapi({ description: "Paid by Keelson's treasury instead." }),
          pending: int().openapi({ description: "Not settled yet." }),
        })
        .openapi({ description: "Verdicts with the operator at fault: what the grade counts." }),
    }),
    reserve: z.object({ warranties: int() }).openapi({
      description:
        "Keelson's own faults on the operator's coverages, paid by its reserve. Not in the grade.",
    }),
    frequency: z.object({
      alpha: z.number(),
      beta: z.number(),
      credibility_ppm: int(),
      mean_ppm: int(),
      upper95_ppm: int(),
    }),
    severity: z.object({ meanMinor: int(), maxMinor: int(), lossRatio_ppm: int() }),
    loss: z.object({
      horizon: int(),
      scenarios: int(),
      expectedMinor: int(),
      var99Minor: int(),
      es99Minor: int(),
      var995Minor: int(),
    }),
    premium: z.object({
      bps: int().openapi({ description: "Charged on each new coverage, in `lockCoverage`." }),
      modelBps: int(),
      floorBps: int(),
      theta: z.number(),
      costOfCapital: z.number(),
    }),
    bond: z.object({ requiredMinor: int() }),
    computeMs: z.number(),
  })
  .openapi("TrustGrade", {
    description:
      "An operator's trust grade, premium and minimum bond. Amounts are US cents. The red-team campaigns set the prior of the incident rate; the operator's covered purchases and the verdicts with it at fault update it in closed form; a seeded Monte Carlo of the aggregate loss over the next 30 days prices the premium and the bond.",
  });

const problemContent = { "application/problem+json": { schema: ProblemSchema } };

const get = createRoute({
  method: "get",
  path: "/v1/operators/{agentId}/grade",
  operationId: "getTrustGrade",
  tags: ["operators"],
  summary: "Trust grade, premium and bond of an operator",
  description:
    "Recomputed whenever a coverage or a verdict of the operator, or the nightly calibration, changes it. Public.",
  request: { params: z.object({ agentId: AgentId }) },
  responses: {
    200: { description: "The grade", content: { "application/json": { schema: TrustGrade } } },
    404: { description: "Not a linked operator", content: problemContent },
    409: {
      description: "Nothing to price the operator's losses from yet",
      content: problemContent,
    },
    503: {
      description: "No finished red-team campaign to calibrate from",
      content: problemContent,
    },
  },
});

const stream = createRoute({
  method: "get",
  path: "/v1/operators/{agentId}/grade/stream",
  operationId: "streamTrustGrade",
  tags: ["operators"],
  summary: "Follow an operator's trust grade",
  description:
    "Server-sent events: a `grade` event with the current grade, and another each time a coverage, a verdict or a calibration changes it. Public.",
  request: { params: z.object({ agentId: AgentId }) },
  responses: {
    200: {
      description: "An event stream",
      content: { "text/event-stream": { schema: z.string() } },
    },
    404: { description: "Not a linked operator", content: problemContent },
    409: {
      description: "Nothing to price the operator's losses from yet",
      content: problemContent,
    },
    503: {
      description: "No calibration yet, or too many open streams",
      content: problemContent,
    },
  },
});

export function registerGrades(app: OpenAPIHono, deps: Pick<Deps, "db" | "log" | "shutdown">) {
  const { db } = deps;
  let open = 0;

  const refused = (c: Context, r: GradeResult) => {
    switch (r.kind) {
      case "unknown":
        return problem(
          c,
          404,
          "operator-not-found",
          "Not found",
          "No linked operator has this agent id.",
        );
      case "unpriced":
        return problem(
          c,
          409,
          "not-priced",
          "Not priced",
          "No covered purchase or mandate to draw the operator's losses from yet.",
        );
      default:
        return problem(
          c,
          503,
          "not-calibrated",
          "Not calibrated",
          "No finished red-team campaign to calibrate the risk model from yet.",
        );
    }
  };

  app.openapi(get, async (c) => {
    const started = performance.now();
    const r = await gradeOf(db, BigInt(c.req.valid("param").agentId));
    if (r.kind !== "graded") return refused(c, r) as never;
    c.header(
      "Server-Timing",
      `grade;dur=${(performance.now() - started).toFixed(1)}, model;dur=${r.grade.computeMs}`,
    );
    c.header("Cache-Control", "no-store");
    return c.json(r.grade, 200);
  });

  app.openapi(stream, async (c) => {
    const agentId = BigInt(c.req.valid("param").agentId);
    const first = await gradeOf(db, agentId);
    if (first.kind !== "graded") return refused(c, first) as never;
    if (open >= MAX_STREAMS) {
      return problem(c, 503, "too-many-streams", "Too many streams", "Try again later.");
    }
    open++;
    return streamSSE(c, async (sse) => {
      const end = (): void => sse.abort();
      deps.shutdown?.addEventListener("abort", end, { once: true });
      if (deps.shutdown?.aborted) end();
      const heartbeat = setInterval(() => {
        sse.write(": heartbeat\n\n").catch(() => {});
      }, HEARTBEAT_MS);
      let r: GradeResult = first;
      let sent: string | undefined;
      try {
        while (!sse.aborted) {
          if (r.kind === "graded" && r.grade.computedAt !== sent) {
            sent = r.grade.computedAt;
            await sse.writeSSE({ event: "grade", data: JSON.stringify(r.grade) });
          }
          await sse.sleep(POLL_MS);
          r = await gradeOf(db, agentId);
        }
      } catch (err) {
        deps.log.warn({ err }, "grade stream failed");
      } finally {
        open--;
        clearInterval(heartbeat);
        deps.shutdown?.removeEventListener("abort", end);
      }
    });
  });
}
