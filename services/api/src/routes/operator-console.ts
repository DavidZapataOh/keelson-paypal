import type Anthropic from "@anthropic-ai/sdk";
import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { type Db, eq, inArray, operators, type SQL, type StoredAmber, sql } from "@keelson/db";
import { CHAINS, isChainId } from "@keelson/relayer";
import type { Context, MiddlewareHandler } from "hono";
import { type Address, getAddress } from "viem";
import { AMBER_FIELD } from "../amber.ts";
import type { Deps } from "../app.ts";
import { rateLimit } from "../middleware/rate-limit.ts";
import { agentAuthority, OPERATOR_CHAIN, walletsOf } from "../operators/owners.ts";
import { ProblemSchema, problem } from "../problem.ts";
import { COVERED } from "../risk.ts";
import { costMicros, reserve, settle } from "./merchant-assistant.ts";
import { DEMO_OPERATOR } from "./operators.ts";

declare module "hono" {
  interface ContextVariableMap {
    /** The session's wallets that may act for the agent in the path. */
    operatorWallets: Address[] | undefined;
  }
}

const PARTIES = ["operator", "keelson", "merchant", "user"] as const;
const OUTCOMES = ["paid", "queued", "claimable", "failed"] as const;
const PAYERS = ["chain", "treasury", "violation-pool"] as const;
const DISPUTE_STATES = ["OPEN", "ATTRIBUTED", "RESOLVED"] as const;
const AMBER_STATES = ["none", "attested", "contradicted"] as const;

const AGENT_ID = /^(0|[1-9]\d{0,19})$/;
const AgentId = z
  .string()
  .regex(AGENT_ID)
  .refine((v) => BigInt(v) < 2n ** 64n, "agent ids are at most 2^64 - 1")
  .openapi({ description: "The operator's ERC-8004 agent id, a decimal integer." });

const problemContent = { "application/problem+json": { schema: ProblemSchema } };
const problems = {
  401: { description: "No session", content: problemContent },
  403: { description: "The session's wallets do not own the agent", content: problemContent },
} as const;

/**
 * Admits a session one of whose wallets (EIP-4361) is the agent's owner or agent wallet in the
 * Identity registry now. Sets `c.var.operatorWallets`.
 */
function requireOperator(
  deps: Pick<Deps, "db">,
  authority: ReturnType<typeof agentAuthority>,
): MiddlewareHandler {
  return async (c, next) => {
    if (c.var.invalidToken) {
      c.header("WWW-Authenticate", 'Bearer error="invalid_token"');
      return problem(c, 401, "invalid-token", "Invalid token", "The access token is invalid.");
    }
    const principal = c.var.principal;
    if (!principal) {
      return problem(c, 401, "unauthorized", "Unauthorized", "An operator session is required.");
    }
    const param = c.req.param("agentId") ?? "";
    // The wallets first: a session without one costs no chain read.
    const wallets = principal.kind === "user" ? await walletsOf(deps.db, principal.subject) : [];
    const allowed =
      wallets.length > 0 && AGENT_ID.test(param) ? await authority(BigInt(param)) : undefined;
    const mine = wallets.filter((w) => allowed?.includes(w));
    if (mine.length === 0) {
      return problem(
        c,
        403,
        "not-operator",
        "Not this operator",
        "Sign in with the wallet that owns this agent in the ERC-8004 Identity registry.",
      );
    }
    c.set("operatorWallets", mine);
    await next();
  };
}

// ---------------------------------------------------------------------------------------------
// The coverage book as AG Grid's server-side row model asks for it.

type Kind = "text" | "number" | "date" | "set";

interface Column {
  kind: Kind;
  /** The SQL expression the column is sorted and filtered on; a constant, never input. */
  expr: string;
  /** The set filter's values, and how each one is stored. */
  values?: readonly string[];
  toDb?: (v: string) => string | number;
  /** Number filters in dollars on a column stored in cents. */
  scale?: number;
}

/** The columns a client may sort and filter on. Anything else is refused. */
const COLUMNS: Record<string, Column> = {
  id: { kind: "text", expr: "p.id" },
  createdAt: { kind: "date", expr: "p.created_at" },
  merchantId: { kind: "text", expr: "p.merchant_id" },
  amount: { kind: "number", expr: "p.amount_minor", scale: 100 },
  premiumBps: { kind: "number", expr: "p.premium_bps" },
  premium: {
    kind: "number",
    expr: "(p.amount_minor * coalesce(p.premium_bps, 0))::numeric / 10000",
    scale: 100,
  },
  state: { kind: "set", expr: "p.state::text", values: COVERED },
  disputeState: { kind: "set", expr: "d.state::text", values: DISPUTE_STATES },
  liable: {
    kind: "set",
    expr: "v.liable",
    values: PARTIES,
    toDb: (v) => PARTIES.indexOf(v as (typeof PARTIES)[number]) + 1,
  },
  outcome: { kind: "set", expr: "v.outcome", values: OUTCOMES },
  paidBy: { kind: "set", expr: "v.paid_by", values: PAYERS },
  amber: {
    kind: "set",
    expr: "case when ac.coverage_id is not null then 'contradicted' when p.amber is not null then 'attested' else 'none' end",
    values: AMBER_STATES,
  },
};
const COLUMN_IDS = Object.keys(COLUMNS) as [string, ...string[]];

const TEXT_OPS = [
  "contains",
  "notContains",
  "equals",
  "notEqual",
  "startsWith",
  "endsWith",
  "blank",
  "notBlank",
] as const;
const COMPARE_OPS = [
  "equals",
  "notEqual",
  "greaterThan",
  "greaterThanOrEqual",
  "lessThan",
  "lessThanOrEqual",
  "inRange",
  "blank",
  "notBlank",
] as const;

const TextCondition = z.object({
  filterType: z.literal("text"),
  type: z.enum(TEXT_OPS),
  filter: z.string().max(200).nullish(),
});
const NumberCondition = z.object({
  filterType: z.literal("number"),
  type: z.enum(COMPARE_OPS),
  filter: z.number().min(-1e12).max(1e12).nullish(),
  filterTo: z.number().min(-1e12).max(1e12).nullish(),
});
const DateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/)
  .refine((v) => !Number.isNaN(Date.parse(v.slice(0, 10))), "not a date");
const DateCondition = z.object({
  filterType: z.literal("date"),
  type: z.enum(COMPARE_OPS),
  dateFrom: DateTime.nullish(),
  dateTo: DateTime.nullish(),
});
const SetFilter = z.object({
  filterType: z.literal("set"),
  values: z.array(z.string().max(64).nullable()).max(64),
});
const Condition = z.discriminatedUnion("filterType", [
  TextCondition,
  NumberCondition,
  DateCondition,
]);
const Combined = z.object({
  filterType: z.enum(["text", "number", "date"]),
  operator: z.enum(["AND", "OR"]),
  conditions: z.array(Condition).min(1).max(4),
});
const ColumnFilter = z.union([Combined, Condition, SetFilter]);

const RowsRequest = z
  .object({
    startRow: z.number().int().min(0).max(10_000_000),
    endRow: z.number().int().min(1).max(10_000_100),
    sortModel: z
      .array(z.object({ colId: z.enum(COLUMN_IDS), sort: z.enum(["asc", "desc"]) }))
      .max(4)
      .default([]),
    filterModel: z
      .partialRecord(z.enum(COLUMN_IDS), ColumnFilter)
      .nullish()
      .transform((f) => f ?? {}),
  })
  .refine((r) => r.endRow > r.startRow && r.endRow - r.startRow <= 500, {
    message: "A block is 1 to 500 rows.",
  })
  .openapi("CoverageRowsRequest", {
    description:
      "AG Grid's `IServerSideGetRowsRequest`: the block, its sort and its filter model (text, number, date and set filters). Amounts are filtered in US dollars.",
  });

const CoverageRow = z
  .object({
    id: z.string().openapi({ description: "The purchase id, also its Alibi's." }),
    createdAt: z.iso.datetime(),
    merchantId: z.string(),
    amount: z.number().openapi({ description: "US dollars." }),
    premiumBps: z.number().int().nullable(),
    premium: z.number().openapi({ description: "US dollars." }),
    state: z.string(),
    coverageTx: z.url().nullable(),
    disputeId: z.string().nullable(),
    disputeState: z.enum(DISPUTE_STATES).nullable(),
    disputeReason: z.string().nullable(),
    disputedAt: z.iso.datetime().nullable(),
    liable: z.enum(PARTIES).nullable(),
    rule: z.string().nullable(),
    verdictAmount: z.number().nullable().openapi({ description: "US dollars." }),
    verdictAt: z.iso.datetime().nullable(),
    outcome: z.enum(OUTCOMES).nullable(),
    paidBy: z.enum(PAYERS).nullable(),
    settlementTx: z.url().nullable(),
    settledAt: z.iso.datetime().nullable(),
    amber: z.enum(AMBER_STATES).openapi({
      description:
        "`attested`: you signed an amber commitment of the item into the coverage. `contradicted`: `AmberContradictionCourt` convicted it with a C2b proof.",
    }),
    amberCommitment: z.string().nullable(),
    amberField: z
      .enum(AMBER_FIELD)
      .nullable()
      .openapi({ description: "The field the court found false." }),
    amberClaimed: z
      .string()
      .nullable()
      .openapi({ description: "What you attested of that field." }),
    amberProvenAt: z.iso.datetime().nullable(),
    amberWebFact: z
      .string()
      .nullable()
      .openapi({ description: "The digest of the `WebFact` the proof opened." }),
    amberTx: z.url().nullable(),
  })
  .openapi("CoverageRow");

class FilterError extends Error {}

const like = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

/** One condition on one column, as SQL with every value a parameter. */
function conditionSql(col: Column, c: z.infer<typeof Condition>): SQL {
  const e = sql.raw(col.expr);
  if (c.type === "blank") return sql`${e} is null`;
  if (c.type === "notBlank") return sql`${e} is not null`;
  if (c.filterType === "text") {
    if (col.kind !== "text") throw new FilterError("a text filter on a non-text column");
    const f = c.filter ?? "";
    switch (c.type) {
      case "contains":
        return sql`${e} ilike ${`%${like(f)}%`}`;
      case "notContains":
        return sql`${e} not ilike ${`%${like(f)}%`}`;
      case "equals":
        return sql`lower(${e}) = lower(${f})`;
      case "notEqual":
        return sql`lower(${e}) <> lower(${f})`;
      case "startsWith":
        return sql`${e} ilike ${`${like(f)}%`}`;
      default:
        return sql`${e} ilike ${`%${like(f)}`}`;
    }
  }
  let from: unknown;
  let to: unknown;
  if (c.filterType === "number") {
    if (col.kind !== "number") throw new FilterError("a number filter on a non-number column");
    if (c.filter == null) throw new FilterError("a number filter without a value");
    from = Math.round(c.filter * (col.scale ?? 1));
    to = c.filterTo == null ? undefined : Math.round(c.filterTo * (col.scale ?? 1));
  } else {
    if (col.kind !== "date") throw new FilterError("a date filter on a non-date column");
    if (!c.dateFrom) throw new FilterError("a date filter without a date");
    // AG's date filter compares calendar days, in UTC here.
    const day = (d: string) => sql`(${d.slice(0, 10)})::date`;
    const on = sql`(${e} at time zone 'UTC')::date`;
    switch (c.type) {
      case "equals":
        return sql`${on} = ${day(c.dateFrom)}`;
      case "notEqual":
        return sql`${on} <> ${day(c.dateFrom)}`;
      case "greaterThan":
        return sql`${on} > ${day(c.dateFrom)}`;
      case "greaterThanOrEqual":
        return sql`${on} >= ${day(c.dateFrom)}`;
      case "lessThan":
        return sql`${on} < ${day(c.dateFrom)}`;
      case "lessThanOrEqual":
        return sql`${on} <= ${day(c.dateFrom)}`;
      default:
        if (!c.dateTo) throw new FilterError("a date range without its end");
        return sql`${on} between ${day(c.dateFrom)} and ${day(c.dateTo)}`;
    }
  }
  switch (c.type) {
    case "equals":
      return sql`${e} = ${from}`;
    case "notEqual":
      return sql`${e} <> ${from}`;
    case "greaterThan":
      return sql`${e} > ${from}`;
    case "greaterThanOrEqual":
      return sql`${e} >= ${from}`;
    case "lessThan":
      return sql`${e} < ${from}`;
    case "lessThanOrEqual":
      return sql`${e} <= ${from}`;
    default:
      if (to === undefined) throw new FilterError("a number range without its end");
      return sql`${e} between ${from} and ${to}`;
  }
}

/**
 * The filter model as SQL predicates, one per column.
 * @internal
 */
export function filterSql(model: Partial<Record<string, z.infer<typeof ColumnFilter>>>): SQL[] {
  return Object.entries(model).flatMap(([colId, f]) => {
    if (!f) return [];
    const col = COLUMNS[colId] as Column;
    if ("values" in f) {
      if (col.kind !== "set") throw new FilterError(`${colId} has no set filter`);
      const known = f.values.filter((v): v is string => v !== null);
      if (known.some((v) => !col.values?.includes(v))) {
        throw new FilterError(`${colId} has no such value`);
      }
      const stored = known.map((v) => (col.toDb ? col.toDb(v) : v));
      const e = sql.raw(col.expr);
      const any =
        stored.length > 0
          ? sql`${e} in (${sql.join(
              stored.map((v) => sql`${v}`),
              sql`, `,
            )})`
          : sql`false`;
      return f.values.includes(null) ? sql`(${any} or ${e} is null)` : any;
    }
    if ("conditions" in f) {
      const parts = f.conditions.map((c) => conditionSql(col, c));
      return sql`(${sql.join(parts, f.operator === "AND" ? sql` and ` : sql` or `)})`;
    }
    return conditionSql(col, f);
  });
}

const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());
const txUrl = (chainId: unknown, hash: unknown) =>
  hash != null && isChainId(Number(chainId))
    ? `${CHAINS[Number(chainId) as keyof typeof CHAINS].explorer}/tx/0x${Buffer.from(hash as Buffer).toString("hex")}`
    : null;

/** The amber columns of a book row: the attestation, and the court's conviction of it. */
function amberColumns(r: Record<string, unknown>) {
  const amber = r.amber as StoredAmber | null;
  const field = r.amber_field == null ? null : (AMBER_FIELD[Number(r.amber_field) - 1] ?? null);
  const claimed =
    amber && field
      ? {
          size: amber.size,
          color: amber.color,
          unit_price: amber.unit_minor,
          returns_free: String(amber.returns_free),
        }[field]
      : null;
  return {
    amber: field ? "contradicted" : amber ? "attested" : "none",
    amberCommitment: amber?.commitment ?? null,
    amberField: field,
    amberClaimed: claimed,
    amberProvenAt: iso(r.amber_at),
    amberWebFact: r.web_fact_digest
      ? `0x${Buffer.from(r.web_fact_digest as Buffer).toString("hex")}`
      : null,
    amberTx: txUrl(r.amber_chain, r.amber_tx),
  } as const;
}

/**
 * The operator's covered purchases, each with its latest dispute and that dispute's verdict.
 * @internal
 */
export async function coverageRows(
  db: Db,
  agentId: bigint,
  request: z.infer<typeof RowsRequest>,
): Promise<{ rows: z.infer<typeof CoverageRow>[]; rowCount: number }> {
  const where = [
    sql`m.operator_agent_id = ${agentId.toString()}`,
    sql`p.state::text in (${sql.join(
      COVERED.map((s) => sql`${s}`),
      sql`, `,
    )})`,
    ...filterSql(request.filterModel),
  ];
  const order = [
    ...request.sortModel.map(
      (s) =>
        sql`${sql.raw((COLUMNS[s.colId] as Column).expr)} ${sql.raw(s.sort === "asc" ? "asc nulls first" : "desc nulls last")}`,
    ),
    sql`p.created_at desc`,
    sql`p.id desc`,
  ];
  // The latest dispute of each of the operator's purchases: disputes are few, so one hash join
  // beats a lookup per row.
  const from = sql`
    from purchases p
    join mandates m on m.id = p.mandate_id
    left join (
      select distinct on (dd.purchase_id) dd.id, dd.purchase_id, dd.state, dd.reason, dd.created_at
      from disputes dd
      join purchases pp on pp.id = dd.purchase_id
      join mandates mm on mm.id = pp.mandate_id
      where mm.operator_agent_id = ${agentId.toString()}
      order by dd.purchase_id, dd.created_at desc
    ) d on d.purchase_id = p.id
    left join verdicts v on v.dispute_id = d.id
    left join amber_convictions ac on ac.purchase_id = p.id
    where ${sql.join(where, sql` and `)}`;
  const [result, counted] = await Promise.all([
    db.execute<Record<string, unknown>>(sql`
      select p.id, p.created_at, p.merchant_id, p.amount_minor, p.premium_bps, p.state, p.chain_id,
        p.coverage_tx_hash, d.id as dispute_id, d.state as dispute_state, d.reason,
        d.created_at as disputed_at, v.liable, v.rule_id, v.amount_minor as verdict_minor,
        v.created_at as verdict_at, v.outcome, v.paid_by, v.chain_id as verdict_chain,
        v.tx_hash, v.settled_at, p.amber, ac.field_id as amber_field, ac.proven_at as amber_at,
        ac.web_fact_digest, ac.chain_id as amber_chain, ac.tx_hash as amber_tx
      ${from}
      order by ${sql.join(order, sql`, `)}
      offset ${request.startRow} limit ${request.endRow - request.startRow}
    `),
    db.execute<{ n: string }>(sql`select count(*) as n ${from}`),
  ]);
  const rows = result.rows.map((r) => {
    const amountMinor = Number(r.amount_minor);
    const bps = r.premium_bps == null ? null : Number(r.premium_bps);
    return {
      id: String(r.id),
      createdAt: iso(r.created_at) as string,
      merchantId: String(r.merchant_id),
      amount: amountMinor / 100,
      premiumBps: bps,
      premium: Math.round((amountMinor * (bps ?? 0)) / 100) / 10_000,
      state: String(r.state),
      coverageTx: txUrl(r.chain_id, r.coverage_tx_hash),
      disputeId: (r.dispute_id as string | null) ?? null,
      disputeState: (r.dispute_state as (typeof DISPUTE_STATES)[number] | null) ?? null,
      disputeReason: (r.reason as string | null) ?? null,
      disputedAt: iso(r.disputed_at),
      liable: r.liable == null ? null : (PARTIES[Number(r.liable) - 1] ?? null),
      rule: r.rule_id == null ? null : `R${String(r.rule_id).padStart(2, "0")}`,
      verdictAmount: r.verdict_minor == null ? null : Number(r.verdict_minor) / 100,
      verdictAt: iso(r.verdict_at),
      outcome: (r.outcome as (typeof OUTCOMES)[number] | null) ?? null,
      paidBy: (r.paid_by as (typeof PAYERS)[number] | null) ?? null,
      settlementTx: txUrl(r.verdict_chain, r.tx_hash),
      settledAt: iso(r.settled_at),
      ...amberColumns(r),
    };
  });
  return { rows, rowCount: Number(counted.rows[0]?.n ?? 0) };
}

const DailyRow = z
  .object({
    day: z.iso.date(),
    coverages: z.number().int(),
    covered: z.number().openapi({ description: "US dollars." }),
    premiums: z.number().openapi({ description: "US dollars." }),
    incidents: z
      .number()
      .int()
      .openapi({ description: "Verdicts with the operator at fault on that day's coverages." }),
  })
  .openapi("CoverageDay");

// ---------------------------------------------------------------------------------------------
// Natural-language grid queries (AG Grid's AI Toolkit), answered by Claude.

const GRID_PROMPT = `You turn an operator's request into the state of a data grid.
The grid lists the operator's covered purchases: each row is a purchase an AI shopping agent made under a user's Keelson mandate, covered by the operator's PYUSD bond.
Columns:
- id: the purchase id (a ULID, also the id of its Alibi receipt).
- createdAt: when the purchase was made.
- merchantId: the store, e.g. mrc_runfast.
- amount: the purchase amount in US dollars.
- premiumBps: the premium Keelson charged on the coverage, in basis points of the amount.
- premium: that premium in US dollars.
- state: the purchase's lifecycle state. SLASHED means a verdict took the loss from the operator's bond; WARRANTY_PAID means Keelson's reserve paid for its own fault; DEFENDED means the merchant's claim was rejected; MERCHANT_LIABLE means the merchant bore it.
- disputeState: OPEN, ATTRIBUTED or RESOLVED; empty when the purchase was never disputed.
- liable: who the signed verdict found at fault (operator, keelson, merchant, user).
- outcome: what happened to the verdict's payment (paid, queued, claimable, failed).
- paidBy: who paid it (chain: the bond or reserve on chain; violation-pool: the operator's pool deposit; treasury: Keelson's own funds).
- amber: none, attested (the operator signed a commitment to the item's size, color, unit price and free returns into the coverage) or contradicted (AmberContradictionCourt convicted that attestation with a zero-knowledge proof of the store's own answer).
"Slashes" or "incidents" are rows whose liable is operator. Amounts are filtered in dollars.
Return the full new grid state: keep what the user did not ask to change, list unchanged top-level state properties in propertiesToIgnore, and explain the change in one plain sentence.`;

const GridQuery = z
  .object({
    prompt: z.string().min(1).max(500),
    gridState: z.record(z.string(), z.unknown()),
    schema: z
      .record(z.string(), z.unknown())
      .openapi({ description: "`gridApi.getStructuredSchema()`, the JSON Schema of grid state." }),
  })
  .openapi("GridQuery");

const GridAnswer = z
  .object({
    gridState: z.record(z.string(), z.unknown()),
    propertiesToIgnore: z.array(z.string()),
    explanation: z.string(),
    model: z.string(),
    costMicros: z.number().int().openapi({ description: "What the query cost, in USD micros." }),
  })
  .openapi("GridAnswer");

/** The grid state a query may change: what the coverage book's server-side row model supports. */
const FEATURES = ["filter", "sort", "columnVisibility"];
const ColumnId = z.enum(COLUMN_IDS);
/** The model's answer, checked against the coverage book before it reaches the console. */
const Answer = z.object({
  gridState: z
    .object({
      filter: z
        .object({ filterModel: z.partialRecord(ColumnId, z.union([ColumnFilter, z.null()])) })
        .nullish(),
      sort: z
        .object({
          sortModel: z.array(z.object({ colId: ColumnId, sort: z.enum(["asc", "desc"]) })),
        })
        .nullish(),
      columnVisibility: z.object({ hiddenColIds: z.array(ColumnId) }).nullish(),
    })
    .strict(),
  propertiesToIgnore: z.array(z.string().max(32)).max(8),
  explanation: z.string().max(1_000),
});

// ---------------------------------------------------------------------------------------------

const Me = z
  .object({
    wallets: z.array(z.string()),
    operators: z.array(
      z.object({ agentId: z.string(), chainId: z.number().int(), name: z.string() }),
    ),
  })
  .openapi("OperatorSelf");

const meRoute = createRoute({
  method: "get",
  path: "/v1/operators/me",
  operationId: "listOwnedOperators",
  tags: ["operators"],
  summary: "The operators the session's wallet owns",
  description:
    "The linked agents whose owner or agent wallet in the Identity registry is a wallet the session signed in with (EIP-4361). A wallet signs in if it owned a linked agent when the agent was linked; ownership is then read on chain on every operator route.",
  responses: {
    200: { description: "The operators", content: { "application/json": { schema: Me } } },
    ...problems,
  },
});

const rowsRoute = createRoute({
  method: "post",
  path: "/v1/operators/{agentId}/coverages/rows",
  operationId: "getCoverageRows",
  tags: ["operators"],
  summary: "A block of the operator's coverages, for AG Grid's server-side row model",
  description:
    "The operator's covered purchases with their latest dispute and verdict, filtered, sorted and paged as AG Grid asks. `rowCount` is the filtered total. A read: no idempotency key.",
  request: {
    params: z.object({ agentId: AgentId }),
    body: { required: true, content: { "application/json": { schema: RowsRequest } } },
  },
  responses: {
    200: {
      description: "The block",
      content: {
        "application/json": {
          schema: z.object({ rows: z.array(CoverageRow), rowCount: z.number().int() }),
        },
      },
    },
    ...problems,
    422: { description: "A filter the column does not have", content: problemContent },
  },
});

const dailyRoute = createRoute({
  method: "get",
  path: "/v1/operators/{agentId}/coverages/daily",
  operationId: "getDailyCoverages",
  tags: ["operators"],
  summary: "The operator's coverages per day",
  description: "Per UTC day: coverages locked, the amount covered, premiums, and incidents.",
  request: { params: z.object({ agentId: AgentId }) },
  responses: {
    200: {
      description: "The days, oldest first",
      content: { "application/json": { schema: z.object({ days: z.array(DailyRow) }) } },
    },
    ...problems,
  },
});

const queryRoute = createRoute({
  method: "post",
  path: "/v1/operators/{agentId}/grid-query",
  operationId: "queryCoverageGrid",
  tags: ["operators"],
  summary: "Turn a sentence into the coverage grid's state",
  description:
    "The backend of AG Grid's AI Toolkit: Claude answers with structured output in the grid's own state schema. The console's daily model budget applies; past it the query runs on `claude-haiku-5-5`.",
  request: {
    params: z.object({ agentId: AgentId }),
    body: { required: true, content: { "application/json": { schema: GridQuery } } },
  },
  responses: {
    200: { description: "The new state", content: { "application/json": { schema: GridAnswer } } },
    ...problems,
    429: { description: "Too many queries, or today's budget is spent", content: problemContent },
    502: { description: "The model did not answer", content: problemContent },
    503: { description: "No model provider configured", content: problemContent },
  },
});

export function registerOperatorConsole(
  app: OpenAPIHono,
  deps: Pick<Deps, "db" | "kv" | "log" | "chains" | "anthropic">,
): void {
  const { db } = deps;
  const authority = agentAuthority(deps.chains);
  const guard = requireOperator(deps, authority);
  app.on(["GET", "POST"], "/v1/operators/:agentId/coverages/*", guard);
  app.on("POST", "/v1/operators/:agentId/grid-query", guard);
  app.on(
    "POST",
    "/v1/operators/:agentId/grid-query",
    rateLimit(deps.kv, { name: "grid-query", limit: 20, windowSec: 60 }),
  );

  app.openapi(meRoute, async (c) => {
    const principal = c.var.principal;
    if (principal?.kind !== "user") {
      return problem(
        c,
        401,
        "unauthorized",
        "Unauthorized",
        "An operator session is required.",
      ) as never;
    }
    const wallets = await walletsOf(db, principal.subject);
    const owners = wallets.map((w) => Buffer.from(w.slice(2), "hex"));
    const linked =
      owners.length === 0
        ? []
        : await db
            .select({
              agentId: operators.agentId,
              chainId: operators.chainId,
              name: operators.name,
            })
            .from(operators)
            .where(inArray(operators.ownerAddress, owners));
    const candidates = linked.filter((o) => o.chainId === OPERATOR_CHAIN);
    if (
      wallets.includes(DEMO_OPERATOR.owner) &&
      !candidates.some((o) => o.agentId === DEMO_OPERATOR.agentId)
    ) {
      const [row] = await db
        .select({ name: operators.name })
        .from(operators)
        .where(eq(operators.agentId, DEMO_OPERATOR.agentId));
      candidates.push({
        agentId: DEMO_OPERATOR.agentId,
        chainId: DEMO_OPERATOR.chainId,
        name: row?.name ?? DEMO_OPERATOR.name,
      });
    }
    const allowed = await Promise.all(candidates.map((o) => authority(o.agentId)));
    const owned = candidates.filter((_, i) => wallets.some((w) => allowed[i]?.includes(w)));
    if (owned.length === 0) {
      return problem(
        c,
        403,
        "not-operator",
        "Not an operator",
        "No wallet of this session owns a linked agent.",
      ) as never;
    }
    return c.json(
      {
        wallets,
        operators: owned.map((o) => ({
          agentId: o.agentId.toString(),
          chainId: o.chainId,
          name: o.name,
        })),
      },
      200,
    );
  });

  app.openapi(rowsRoute, async (c) => {
    const agentId = BigInt(c.req.valid("param").agentId);
    const started = performance.now();
    try {
      const block = await coverageRows(db, agentId, c.req.valid("json"));
      c.header("Server-Timing", `db;dur=${(performance.now() - started).toFixed(1)}`);
      c.header("Cache-Control", "no-store");
      return c.json(block, 200);
    } catch (err) {
      if (err instanceof FilterError) {
        return problem(c, 422, "bad-filter", "Bad filter", err.message);
      }
      throw err;
    }
  });

  app.openapi(dailyRoute, async (c) => {
    const agentId = BigInt(c.req.valid("param").agentId).toString();
    const result = await db.execute<Record<string, unknown>>(sql`
      select to_char((p.created_at at time zone 'UTC')::date, 'YYYY-MM-DD') as day,
        count(*) as coverages, sum(p.amount_minor) as covered,
        sum(p.amount_minor * coalesce(p.premium_bps, 0)) as premiums_bps,
        count(v.id) filter (where v.liable = 1) as incidents
      from purchases p
      join mandates m on m.id = p.mandate_id
      left join lateral (
        select id from disputes where purchase_id = p.id order by created_at desc limit 1
      ) d on true
      left join verdicts v on v.dispute_id = d.id
      where m.operator_agent_id = ${agentId}
        and p.state::text in (${sql.join(
          COVERED.map((s) => sql`${s}`),
          sql`, `,
        )})
      group by 1 order by 1
    `);
    c.header("Cache-Control", "no-store");
    return c.json(
      {
        days: result.rows.map((r) => ({
          day: String(r.day),
          coverages: Number(r.coverages),
          covered: Number(r.covered) / 100,
          premiums: Math.round(Number(r.premiums_bps) / 100) / 10_000,
          incidents: Number(r.incidents),
        })),
      },
      200,
    );
  });

  app.openapi(queryRoute, (async (c: Context) => {
    const anthropic = deps.anthropic;
    if (!anthropic) return problem(c, 503, "dependency-unavailable", "Model unavailable");
    const agentId = c.req.param("agentId") as string;
    const raw = await c.req.text();
    if (raw.length > 128 * 1024) {
      return problem(c, 413, "payload-too-large", "Payload too large");
    }
    const parsed = GridQuery.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      return problem(c, 400, "malformed-body", "Malformed body", parsed.error.message);
    }
    const body = parsed.data;
    const { $defs, ...stateSchema } = body.schema as { $defs?: unknown } & Record<string, unknown>;
    const features = Object.keys((stateSchema.properties ?? {}) as Record<string, unknown>);
    if (stateSchema.type !== "object" || features.some((f) => !FEATURES.includes(f))) {
      return problem(
        c,
        422,
        "not-grid-state",
        "Not grid state",
        `The schema may describe only ${FEATURES.join(", ")}.`,
      );
    }
    const budgetKey = `operator-${agentId}`;
    const turn = await reserve(deps.kv, budgetKey, "claude-opus-5-5", Buffer.byteLength(raw));
    if (!turn) {
      return problem(
        c,
        429,
        "budget-spent",
        "Budget spent",
        "Today's query budget is spent; it resets at 00:00 UTC.",
      );
    }
    // The full state schema compiles to a grammar larger than structured outputs take, so the
    // schema goes in the prompt and the answer is checked here (AG Grid's AI Toolkit allows both).
    const schema = {
      type: "object",
      properties: {
        gridState: stateSchema,
        propertiesToIgnore: { type: "array", items: { type: "string", enum: FEATURES } },
        explanation: { type: "string" },
      },
      required: ["gridState", "propertiesToIgnore", "explanation"],
      additionalProperties: false,
      ...($defs ? { $defs } : {}),
    };
    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await anthropic.beta.messages.create(
        {
          model: turn.model,
          max_tokens: 8_000,
          system: GRID_PROMPT,
          messages: [
            {
              role: "user",
              content: `Answer with one JSON object, and nothing else, valid against this JSON Schema:\n${JSON.stringify(schema)}\n\nCurrent grid state:\n${JSON.stringify(body.gridState)}\n\nRequest: ${body.prompt}`,
            },
          ],
          thinking: { type: "adaptive" },
          output_config: { effort: "low" },
          ...(turn.model === "claude-haiku-5-5"
            ? {}
            : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        },
        { ...GRID_LIMITS, signal: c.req.raw.signal },
      );
    } catch (err) {
      await settle(deps.kv, budgetKey, turn, 0);
      deps.log.warn({ err, agentId }, "the model refused a grid query");
      return problem(c, 502, "model-error", "Model error", "The model did not answer this query.");
    }
    const priced = message.model === "claude-haiku-5-5" ? "claude-haiku-5-5" : "claude-opus-5-5";
    const cost = costMicros(priced, message.usage);
    await settle(deps.kv, budgetKey, turn, cost);
    const text = message.content.find((b) => b.type === "text");
    if (message.stop_reason !== "end_turn" || !text || text.type !== "text") {
      return problem(c, 502, "model-error", "Model error", "The model gave no grid state.");
    }
    let json: unknown;
    try {
      json = JSON.parse(text.text.slice(text.text.indexOf("{"), text.text.lastIndexOf("}") + 1));
    } catch {
      json = undefined;
    }
    const checked = Answer.safeParse(json);
    if (!checked.success) {
      return problem(c, 502, "model-error", "Model error", "The model's answer is not grid state.");
    }
    const answer = checked.data;
    deps.log.info({ agentId, model: message.model, costMicros: cost }, "grid query answered");
    return c.json({ ...answer, model: message.model, costMicros: cost }, 200);
  }) as never);
}

/**
 * The grid query's model call: one attempt (the server-side fallback answers an overloaded
 * model), timed out before the 30 s handler, so the turn settles and answers `model-error`.
 * @internal
 */
export const GRID_LIMITS = { timeout: 25_000, maxRetries: 0 } as const;

/** The wallets of a session that may act for an agent, or none: the deposit route's operator check. */
export function operatorWallets(
  deps: Pick<Deps, "db" | "chains">,
): (userId: string, agentId: bigint) => Promise<Address[]> {
  const authority = agentAuthority(deps.chains);
  return async (userId, agentId) => {
    const wallets = await walletsOf(deps.db, userId);
    if (wallets.length === 0) return [];
    const allowed = await authority(agentId);
    return wallets.filter((w) => allowed?.includes(getAddress(w)));
  };
}
