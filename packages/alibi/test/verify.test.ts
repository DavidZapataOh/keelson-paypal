import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { fromBase64, toBase64 } from "../src/b64.ts";
import { receiptOf } from "../src/codec.ts";
import type { AlibiBundle } from "../src/schema.ts";
import { verifyAlibi } from "../src/verify/index.ts";
import { copy, fixtures } from "./fixtures.ts";

const realFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = () => {
    throw new Error("verification must not use the network");
  };
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

const flipB64 = (s: string, at: number) => {
  const b = fromBase64(s);
  b[at] = (b[at] as number) ^ 1;
  return toBase64(b);
};
const flipHex = (h: string, at = 10) =>
  `${h.slice(0, at)}${h[at] === "0" ? "1" : "0"}${h.slice(at + 1)}`;

/** Asserts that `check` fails and reads the edited pointer or a part of it. */
async function fails(b: AlibiBundle, check: string, edited: string, reason?: string) {
  const report = await verifyAlibi(b);
  const c = report.checks.find((x) => x.id === check);
  expect(c?.status, `${check}: ${JSON.stringify(c)}`).toBe("fail");
  expect(
    c?.reads.some((r) => edited.startsWith(r) || r.startsWith(edited)),
    JSON.stringify(c?.reads),
  ).toBe(true);
  if (reason) expect(c?.reason).toContain(reason);
  expect(report.verdict).toBe("failed");
}

describe.each(fixtures.map((f) => [f.id, f] as const))("alibi %s", (_, f) => {
  const b = f.bundle;

  // The first verification starts bb.js and the policy engine.
  test("verifies offline with no failing check", { timeout: 30_000 }, async () => {
    const report = await verifyAlibi(b);
    expect(report.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(report.verdict).toBe("verified-offline");
    const anchor = report.checks.find((c) => c.id === "anchor.consistency");
    expect(anchor?.status).toBe(f.anchored ? "pass" : "pending");
    expect(report.checks.find((c) => c.id === "zk.c1")?.status).toBe("absent");
  });

  test("its receipt verifies what the log publishes and discloses nothing else", async () => {
    const report = await verifyAlibi(receiptOf(b));
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(status).toMatchObject({
      "bundle.format": "pass",
      "leaf.view": "pass",
      "log.inclusion": "pass",
      "log.witnesses": "pass",
      timestamps: "pass",
      "tee.countersign": "undisclosed",
      "log.policy": "undisclosed",
      "evidence.manifest": "undisclosed",
      "paypal.ids": "undisclosed",
    });
    expect(report.verdict).toBe("incomplete");
  });

  const leafText = new TextDecoder().decode(fromBase64(b.leaf));
  const cases: [string, string, (x: AlibiBundle) => void, string?][] = [
    [
      "a byte of the leaf JSON",
      "leaf.view",
      (x) => {
        x.leaf = flipB64(x.leaf, 60);
      },
      "/leaf",
    ],
    [
      "the leaf prefix",
      "leaf.view",
      (x) => {
        x.leaf = toBase64(new TextEncoder().encode(leafText.replace("/v1", "/v2")));
      },
      "/leaf",
    ],
    [
      "leaf_view.cart_hash",
      "leaf.view",
      (x) => {
        x.leaf_view.cart_hash = `A${String(x.leaf_view.cart_hash).slice(1)}`;
      },
      "/leaf_view/cart_hash",
    ],
    [
      "an observed value of the trace",
      "tee.countersign",
      (x) => {
        (x.eval.fields[0] as { observed: unknown }).observed = "changed";
      },
      "/eval/fields/0/observed",
    ],
    [
      "the countersigned amount",
      "tee.countersign",
      (x) => {
        x.tee.countersign.amount = String(Number(x.tee.countersign.amount) + 1);
      },
      "/tee/countersign/amount",
    ],
    [
      "a byte of the last signature",
      "tee.countersign",
      (x) => {
        const s = x.tee.signatures[x.tee.signatures.length - 1] as { signature: string };
        s.signature = flipHex(s.signature, 20);
      },
      `/tee/signatures/${b.tee.signatures.length - 1}/signature`,
    ],
    [
      "a manifest leaf",
      "evidence.manifest",
      (x) => {
        const item = x.manifest.public.items[x.manifest.public.items.length - 1] as {
          leaf: string;
        };
        item.leaf = flipHex(item.leaf);
      },
      `/manifest/public/items/${b.manifest.public.items.length - 1}/leaf`,
    ],
    [
      "a disclosure salt",
      "evidence.manifest",
      (x) => {
        const d = x.manifest.disclosures[0] as { salt: string };
        d.salt = flipHex(d.salt);
      },
      "/manifest/disclosures/0/salt",
    ],
    [
      "the order id",
      "paypal.ids",
      (x) => {
        x.paypal.order_id += "X";
      },
      "/paypal/order_id",
    ],
    [
      "the PayPal ref salt",
      "paypal.ids",
      (x) => {
        x.paypal.ref_salt = flipHex(x.paypal.ref_salt);
      },
      "/paypal/ref_salt",
    ],
    [
      "a hash of the inclusion proof",
      "log.inclusion",
      (x) => {
        const lines = x.tlog_proof.split("\n");
        const i = lines.findIndex((l, k) => k > 1 && /^[A-Za-z0-9+/]{43}=$/.test(l));
        lines[i] = flipB64(lines[i] as string, 3);
        x.tlog_proof = lines.join("\n");
      },
      "/tlog_proof",
    ],
    [
      "all but one witness cosignature",
      "log.witnesses",
      (x) => {
        const cosigs = x.tlog_proof.split("\n").filter((l) => l.startsWith("— witness-"));
        for (const l of cosigs.slice(1)) x.tlog_proof = x.tlog_proof.replace(`${l}\n`, "");
      },
      "/tlog_proof",
    ],
    [
      "an attacker's witness in the policy",
      "log.policy",
      (x) => {
        x.policy.text = x.policy.text.replace(
          /witness w3 \S+/,
          "witness w3 witness-3.keelson.finance+00000000+BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        );
      },
      "/policy/text",
    ],
    [
      "a byte of a timestamp token",
      "timestamps",
      (x) => {
        const t = x.timestamps[0] as { token: string };
        t.token = flipB64(t.token, fromBase64(t.token).length - 40);
      },
      "/timestamps/0/token",
    ],
  ];
  if (b.paypal.invoice_id) {
    cases.push([
      "the invoice id of another alibi",
      "paypal.ids",
      (x) => {
        x.paypal.invoice_id = (x.paypal.invoice_id as string).replace(
          x.alibi_id,
          fixtures.find((o) => o.id !== x.alibi_id)?.id ?? "01M00000000000000000000000",
        );
      },
      "/paypal/invoice_id",
    ]);
  }
  if (f.mode === "degraded") {
    cases.push([
      "relabelled 2of2",
      "tee.countersign",
      (x) => {
        x.tee.mode = "2of2";
      },
      "/tee/mode",
    ]);
    cases.push([
      "relabelled 2of2",
      "leaf.view",
      (x) => {
        x.tee.mode = "2of2";
      },
      "/tee/mode",
    ]);
  }

  test.each(cases)("%s fails %s", async (_, check, edit, pointer) => {
    const x = copy(b);
    edit(x);
    await fails(x, check, pointer as string);
  });
});
