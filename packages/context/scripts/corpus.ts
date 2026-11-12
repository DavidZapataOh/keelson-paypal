// Writes src/corpus.json from the SDKs' READMEs and examples and the developer OpenAPI subset.
import { readFileSync, writeFileSync } from "node:fs";

const repo = new URL("../../../", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, repo), "utf8");

interface Section {
  source: string;
  language: "typescript" | "python" | "any";
  title: string;
  text: string;
}

function sections(path: string, language: Section["language"]): Section[] {
  const out: Section[] = [];
  let title = path;
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) out.push({ source: path, language, title, text });
  };
  let fenced = false;
  for (const line of read(path).split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && /^#{1,3} /.test(line)) {
      flush();
      title = line.replace(/^#+ /, "");
      lines = [];
    } else lines.push(line);
  }
  flush();
  return out;
}

const docs: Section[] = [
  ...sections("packages/sdk/README.md", "typescript"),
  ...sections("packages/sdk-python/README.md", "python"),
  ...sections("packages/verify/README.md", "typescript"),
  {
    source: "packages/sdk/examples/quickstart.mjs",
    language: "typescript",
    title: "Quickstart (TypeScript)",
    text: `\`\`\`js\n${read("packages/sdk/examples/quickstart.mjs")}\`\`\``,
  },
  {
    source: "packages/sdk-python/examples/quickstart.py",
    language: "python",
    title: "Quickstart (Python)",
    text: `\`\`\`python\n${read("packages/sdk-python/examples/quickstart.py")}\`\`\``,
  },
];

/** The SDK call for each operation: [TypeScript, Python]. */
const CALLS: Record<string, [string, string]> = {
  getStatus: ["await keelson.status()", "client.status()"],
  streamEvents: [
    'for await (const e of keelson.events.stream("public:purchases")) console.log(e.data);',
    'for e in client.events.stream("public:purchases"):\n    print(e.data)',
  ],
  requestMandate: [
    'const req = await keelson.mandates.request({ name: "My agent", reason, perPurchase: "$100", total: "$100", until: "1h" });',
    'req = client.mandates.request(name="My agent", reason=reason, per_purchase="$100", total="$100", until="1h")',
  ],
  getConnectionRequest: [
    "const state = await keelson.requests.retrieve(req.id);",
    "state = client.requests.retrieve(req.id)",
  ],
  requestMandateChange: [
    'await keelson.mandates.requestChange(mandate.id, { note: "Needs $20 more for shipping", total: "$120" });',
    'client.mandates.request_change(mandate.id, note="Needs $20 more for shipping", total="$120")',
  ],
  checkCart: [
    "const check = await keelson.mandates.check(mandate.id, cart);",
    "check = client.mandates.check(mandate.id, cart)",
  ],
  listOperatorMandates: [
    "const mandates = await keelson.mandates.list(agentId);",
    "mandates = client.mandates.list(agent_id)",
  ],
  storeEvidence: [
    "const { evidenceRoot } = await keelson.evidence.seal({ mandateId: mandate.id, sources: { ...sources, observation } });",
    'sealed = client.evidence.seal(mandate_id=mandate.id, sources={**q["sources"], "observation": observation})',
  ],
  countersign: [
    "const { purchaseId } = await keelson.purchases.countersign({ mandate, evidenceRoot, cart });",
    'signed = client.purchases.countersign(mandate=mandate, evidence_root=sealed["evidenceRoot"], cart=q["cart"])',
  ],
  getPurchase: [
    "const purchase = await keelson.purchases.waitFor(purchaseId);",
    "purchase = client.purchases.wait_for(signed.purchase_id)",
  ],
  getAlibi: [
    "const report = await verifyAlibi(await keelson.alibis.retrieve(purchaseId)); // @keelson-finance/verifier",
    "report = verify_alibi(client.alibis.retrieve(purchase.id))",
  ],
  getAlibiReceipt: [
    "const receipt = await keelson.alibis.receipt(purchaseId);",
    "receipt = client.alibis.receipt(purchase.id)",
  ],
  getAlibiPdf: [
    "const pdf = await keelson.alibis.pdf(purchaseId);",
    "pdf = client.alibis.pdf(purchase.id)",
  ],
  verifyAlibi: [
    "const report = await keelson.alibis.verifyRemote(bytes);",
    "report = client.alibis.verify_remote(data)",
  ],
  getTrustGrade: [
    "const grade = await keelson.operators.grade(agentId);",
    "grade = client.operators.grade(agent_id)",
  ],
  linkOperator: [
    'await keelson.operators.link({ chainId: 421614, agentId, name: "My agent", cnfJwk });',
    'client.operators.link(chain_id=421614, agent_id=agent_id, name="My agent", cnf_jwk=cnf_jwk)',
  ],
  announceRun: [
    'await keelson.operators.announceRun(agentId, mandate.id, { state: "started" });',
    'client.operators.announce_run(agent_id, mandate.id, state="started")',
  ],
};

const spec = JSON.parse(read("openapi/keelson.public.json")) as {
  paths: Record<string, Record<string, Record<string, unknown>>>;
  components: { schemas: Record<string, unknown> };
};
const operations = Object.entries(spec.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => {
    const security = (op.security as Record<string, string[]>[] | undefined) ?? [];
    const id = op.operationId as string;
    return {
      operationId: id,
      method: method.toUpperCase(),
      path,
      summary: (op.summary as string) ?? "",
      description: (op.description as string) ?? "",
      scopes: security.flatMap((s) => s.oauth2 ?? []),
      typescript: CALLS[id]?.[0] ?? null,
      python: CALLS[id]?.[1] ?? null,
    };
  }),
);
writeFileSync(
  new URL("../src/corpus.json", import.meta.url),
  `${JSON.stringify({ docs, operations, schemas: spec.components.schemas }, null, 2)}\n`,
);
