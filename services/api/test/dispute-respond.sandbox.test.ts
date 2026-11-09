import Anthropic from "@anthropic-ai/sdk";
import { disputeResponses, eq } from "@keelson/db";
import { adjudicate, getDispute, requireEvidence } from "@keelson/paypal";
import { pino } from "pino";
import { beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../src/app.ts";
import { respondToDispute } from "../src/disputes/respond.ts";
import { createPayPalDeps } from "../src/paypal.ts";
import { fixture, seed } from "./dispute-fixture.ts";
import { testDb, testKv } from "./setup.ts";

/** A buyer-opened sandbox dispute waiting for the seller's evidence. */
const disputeId = process.env.PAYPAL_RESPOND_DISPUTE_ID;
const log = pino({ level: process.env.LOG_LEVEL ?? "info" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!disputeId || !fixture)("dispute response (sandbox)", () => {
  const id = disputeId as string;
  let deps: Parameters<typeof respondToDispute>[0];

  beforeAll(async () => {
    deps = {
      db: testDb,
      log,
      paypal: createPayPalDeps({
        PAYPAL_CLIENT_ID: process.env.PAYPAL_CLIENT_ID ?? "",
        PAYPAL_CLIENT_SECRET: process.env.PAYPAL_CLIENT_SECRET ?? "",
        PAYPAL_ENV: "sandbox",
        PAYPAL_MERCHANT_ID: process.env.PAYPAL_MERCHANT_ID ?? "unused",
      }),
      anthropic: process.env.ANTHROPIC_API_KEY ? new Anthropic() : undefined,
    };
    await seed(id);
  });

  test(
    "answers a friendly-fraud claim with the Alibi and wins it",
    async () => {
      const first = await respondToDispute(deps, id);
      log.info({ first }, "first run");
      if (first.status === "waiting") {
        // A rerun on a fresh database resumes: PayPal already holds the evidence of an earlier run.
        const d = (await getDispute(deps.paypal.paypal.fetch, id)) as {
          evidences?: { source?: string; action_info?: { action?: string } }[];
        };
        expect(
          d.evidences?.some(
            (e) =>
              e.source === "SUBMITTED_BY_SELLER" && e.action_info?.action === "PROVIDE_EVIDENCE",
          ),
        ).toBe(true);
      } else {
        expect(first).toMatchObject({ status: "sent", action: "provide_evidence" });
        if (deps.anthropic) expect(first).toMatchObject({ drafted: "model" });

        const again = await respondToDispute(deps, id);
        expect(["already_sent", "waiting"]).toContain(again.status);
        expect(
          await testDb.select().from(disputeResponses).where(eq(disputeResponses.disputeId, id)),
        ).toHaveLength(1);

        const app = createApp({ db: testDb, kv: testKv, log });
        const shown = await (await app.request(`/v1/disputes/${id}`)).json();
        log.info({ responses: shown.responses }, "GET /v1/disputes");
        expect(shown.responses[0]).toMatchObject({
          action: "provide_evidence",
          evidence_types: ["PERMISSION_DESCRIPTION"],
        });
      }

      // The sandbox stands in for PayPal's agent: once the evidence is in, it decides.
      const f = deps.paypal.paypal.fetch;
      let adjudicated = false;
      let requested = false;
      const deadline =
        Date.now() + Number(process.env.PAYPAL_DISPUTE_TIMEOUT_SECONDS ?? 900) * 1000;
      while (Date.now() < deadline) {
        const d = await getDispute(f, id);
        const rels = new Set(d.links?.map((l) => l.rel));
        log.info(
          { status: d.status, stage: d.dispute_life_cycle_stage, links: [...rels] },
          "dispute",
        );
        if (d.status === "RESOLVED") break;
        if (rels.has("provide_evidence")) {
          // PayPal asked again (a sandbox require-evidence): the workflow answers each request.
          log.info({ again: await respondToDispute(deps, id) }, "answered again");
        } else if (!adjudicated && rels.has("adjudicate")) {
          await adjudicate(f, id, "SELLER_FAVOR");
          adjudicated = true;
        } else if (!requested && !adjudicated && rels.has("require_evidence")) {
          await requireEvidence(f, id, "SELLER_EVIDENCE");
          requested = true;
        }
        await sleep(5_000);
      }
      const final = (await getDispute(f, id)) as { status: string; dispute_outcome?: unknown };
      if (final.status !== "RESOLVED") {
        throw new Error(
          `dispute ${id} is still ${final.status}; the sandbox has not offered adjudication yet, rerun later`,
        );
      }
      log.info({ status: final.status, outcome: final.dispute_outcome }, "final");
      expect(final.status).toBe("RESOLVED");
      expect(final.dispute_outcome).toMatchObject({ outcome_code: "RESOLVED_SELLER_FAVOUR" });
    },
    4 * 3_600_000,
  );
});
