import { connect, type Host } from "./host.ts";

interface AlibiCard {
  purchaseId: string;
  state: string;
  amount: { currency: string; minor: number };
  mode: "2of2" | "degraded" | null;
  decision: "allow" | "deny" | null;
  merchant: string | null;
  items: { sku: string; size: string | null }[];
  fields: { id: string; field: string; liability: Liability; pass: boolean }[];
  logIndex: string | null;
  timestamps: number;
  anchor: { chainId: number; txHash: string; blockNumber: string } | null;
  capture: { id: string; status: string | null } | null;
  failure: { step: string; reason: string } | null;
  verifyUrl: string | null;
  issuedAt: string | null;
}
type Liability = "verified" | "attested" | "yours";

const SVG = "http://www.w3.org/2000/svg";
const CHAINS: Record<number, string> = { 421614: "Arbitrum Sepolia", 42161: "Arbitrum One" };
const LIABILITY: Record<Liability, string> = {
  verified: "Keelson-verified",
  attested: "Operator-attested · bonded",
  yours: "Yours · not covered",
};
const SHAPES: Record<Liability, string> = {
  verified:
    '<rect x="1" y="1" width="14" height="14" rx="2" fill="currentColor"/><path d="m4.5 8.25 2.25 2.25 4.75-5" fill="none" stroke="var(--background)" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>',
  attested:
    '<path d="M8 1.25 14.75 8 8 14.75 1.25 8Z" fill="currentColor" fill-opacity=".15" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  yours:
    '<circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/>',
};

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string | null,
  ...children: (Node | string | null)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

function mark(kind: Liability): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", LIABILITY[kind]);
  svg.setAttribute("class", `mark ${kind}`);
  svg.innerHTML = SHAPES[kind];
  return svg;
}

const money = (a: AlibiCard["amount"]) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: a.currency }).format(a.minor / 100);
const short = (id: string) => `${id.slice(0, 6)}…${id.slice(-4)}`;
const words = (s: string) =>
  s.charAt(0).toUpperCase() + s.slice(1).toLowerCase().replaceAll("_", " ");

/** Keelson's act, in vermilion: the countersign or the block. A failure is ink with "!". */
function status(card: AlibiCard): HTMLElement {
  if (card.state === "FAILED") return el("span", "chip error", el("b", null, "!"), "Failed");
  if (card.decision === "deny" || card.state === "DENIED") {
    return el("span", "chip act", el("i", "square"), "Blocked");
  }
  if (card.decision === "allow") return el("span", "chip act", el("i", "chevron"), "Countersigned");
  return el("span", "chip", el("i", "dot"), words(card.state));
}

function row(label: string, value: Node | string): HTMLElement {
  return el("div", "row", el("dt", null, label), el("dd", null, value));
}

function render(card: AlibiCard, host: Host): void {
  const root = document.getElementById("alibi") as HTMLElement;
  const what = [card.merchant, ...card.items.map((i) => (i.size ? `${i.sku} · ${i.size}` : i.sku))]
    .filter(Boolean)
    .join(" · ");

  const head = el(
    "header",
    null,
    el("p", "eyebrow", "Alibi ", el("span", "mono", short(card.purchaseId))),
    status(card),
  );
  const amount = el(
    "p",
    "amount",
    money(card.amount),
    el("span", "currency", ` ${card.amount.currency}`),
  );

  const facts = el("dl", "facts");
  facts.append(row("State", words(card.state)));
  if (card.mode)
    facts.append(row("Countersign", card.mode === "2of2" ? "2-of-2 TEEs" : "Degraded, one TEE"));
  if (card.logIndex) facts.append(row("Log index", el("span", "mono", card.logIndex)));
  facts.append(row("Timestamps", String(card.timestamps)));
  facts.append(
    row(
      "Anchor",
      card.anchor
        ? `${CHAINS[card.anchor.chainId] ?? `Chain ${card.anchor.chainId}`} · block ${card.anchor.blockNumber}`
        : "Pending",
    ),
  );
  if (card.capture) facts.append(row("PayPal capture", el("span", "mono", card.capture.id)));
  if (card.failure) facts.append(row("Failed at", `${card.failure.step}: ${card.failure.reason}`));

  const fields = el("ul", "fields");
  for (const f of card.fields) {
    fields.append(
      el(
        "li",
        f.pass ? null : "fail",
        mark(f.liability),
        el("span", "name", f.id.replaceAll("_", " ")),
        el("span", "who", f.pass ? LIABILITY[f.liability] : "Did not hold"),
      ),
    );
  }

  const verdict = el("p", "verdict");
  verdict.setAttribute("role", "status");
  const verify = el("button", "primary", "Verify");
  verify.type = "button";
  verify.disabled = card.verifyUrl === null;
  verify.addEventListener("click", async () => {
    verify.disabled = true;
    verdict.textContent = "Checking signatures, log inclusion, timestamps and anchor…";
    try {
      const result = await host.request("tools/call", {
        name: "keelson.verify_alibi",
        arguments: { purchaseId: card.purchaseId },
      });
      const report = result.structuredContent as
        | { verdict: string; checks: { status: string }[] }
        | undefined;
      if (result.isError || !report) throw new Error();
      const passed = report.checks.filter((c) => c.status === "pass").length;
      verdict.textContent = `${words(report.verdict.replaceAll("-", "_"))}: ${passed} of ${report.checks.length} checks pass.`;
      verdict.dataset.verdict = report.verdict.startsWith("verified") ? "ok" : "fail";
    } catch {
      verdict.textContent = "The check did not run. Try again, or open the verifier.";
      verdict.dataset.verdict = "fail";
    } finally {
      verify.disabled = false;
    }
  });
  const open = el("button", "ghost", "Open verifier ↗");
  open.type = "button";
  open.disabled = card.verifyUrl === null;
  open.addEventListener("click", () => {
    if (card.verifyUrl) void host.request("ui/open-link", { url: card.verifyUrl });
  });

  root.replaceChildren(
    head,
    amount,
    what ? el("p", "what", what) : "",
    card.fields.length > 0
      ? el("section", null, el("h2", null, "Who answers for each field"), fields)
      : "",
    facts,
    el("footer", null, verify, open),
    verdict,
  );
  root.removeAttribute("aria-busy");
}

let host: Host | undefined;
let card: AlibiCard | undefined;
host = await connect(
  { name: "Keelson Alibi", version: "0.1.0" },
  {
    toolResult(result) {
      card = result.structuredContent as unknown as AlibiCard | undefined;
      if (card && host) render(card, host);
    },
    context(ctx) {
      if (ctx.theme) document.documentElement.dataset.theme = ctx.theme;
    },
  },
);
if (card) render(card, host);
