import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { clientCredentials, Keelson, KeelsonAgent, unwrap } from "../src/index.ts";

// As an operator's agent on Keelson's sandbox, with its OAuth client and `cnf` key:
//   KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET, KEELSON_AGENT_ID, KEELSON_AGENT_KEY
// The purchase needs a mandate the user signed for that operator and whose PayPal hold they
// approved, with $129 left on it.
const { KEELSON_CLIENT_ID, KEELSON_CLIENT_SECRET, KEELSON_AGENT_ID, KEELSON_AGENT_KEY } =
  process.env;
const operator = describe.runIf(
  KEELSON_CLIENT_ID && KEELSON_CLIENT_SECRET && KEELSON_AGENT_ID && KEELSON_AGENT_KEY,
);
const run = promisify(execFile);

operator("an operator's agent on the sandbox", () => {
  const keelson = new Keelson({
    auth: clientCredentials({
      clientId: KEELSON_CLIENT_ID as string,
      clientSecret: KEELSON_CLIENT_SECRET as string,
      scopes: ["countersign:write", "evidence:write"],
    }),
  });
  const agent = new KeelsonAgent(keelson, { agentId: KEELSON_AGENT_ID as string });

  test("asks the user for a mandate: a link and a number to show, then a poll", async () => {
    const asked = await agent.requestMandate({
      name: "Keelson SDK test",
      reason:
        "The SDK's own test asks for this mandate to check that a request reaches you; decline it, or let it expire in fifteen minutes.",
      perPurchaseMinor: 1_000,
      totalMinor: 1_000,
      until: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(asked.status).toBe("pending_approval");
    expect(asked.next).toMatchObject({
      action: "show_user_then_poll",
      tool: "keelson.get_request",
    });
    const fields = asked as typeof asked & { approvalUrl: string; matchNumber: number | null };
    expect(fields.approvalUrl).toMatch(/^https:\/\/app\.keelson\.finance\/connect\/\?c=/);
    expect(fields.matchNumber).toBeTypeOf("number");
    expect(asked.next.say).toContain(String(fields.matchNumber));
  });

  test("lists the operator's active mandates", async () => {
    const mandates = await agent.listMandates();
    for (const m of mandates) expect(m.state).toBe("ACTIVE");
  });

  test(
    "the countersign example completes a purchase that PayPal captures, and its Alibi verifies",
    async () => {
      const { stdout } = await run("node", ["examples/countersign.ts"], {
        env: process.env,
        timeout: 5 * 60_000,
      });
      expect(stdout).toMatch(/^success Purchase (\w{26}) (is|was) captured/m);
      const purchaseId = /Purchase (\w{26})/.exec(stdout)?.[1] as string;
      const purchase = await unwrap(keelson.getPurchase({ path: { id: purchaseId } }));
      expect(purchase.capture?.id).toBeTruthy();
      const verified = await run("node", ["examples/verify-alibi.ts", purchaseId]);
      expect(verified.stdout.trim().split("\n").at(-1)).toBe("verified-offline");
    },
    6 * 60_000,
  );
});
