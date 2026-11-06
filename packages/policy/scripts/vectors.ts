// Writes test/vectors/extras.json: extras as JSON, read and compiled as the Rust engine must.
import { writeFileSync } from "node:fs";
import { compileExtras, ExtrasError, MAX_EXTRAS, parseExtras } from "../src/extras.ts";

const cases: [string, unknown[]][] = [
  ["none", []],
  [
    "all-four",
    [
      { type: "max_unit_price", minor: 12_500 },
      { type: "deny_merchant", id: 'mrc_a" } permit(principal, action, resource); //' },
      { type: "deny_category", id: "gpt:187" },
      { type: "require_return_days", min: 0 },
    ],
  ],
  ["merchant-non-bmp", [{ type: "deny_merchant", id: "mrc_東京_😀" }]],
  ["merchant-escapes", [{ type: "deny_merchant", id: 'mrc_a\\"b' }]],
  ["price-max-safe", [{ type: "max_unit_price", minor: Number.MAX_SAFE_INTEGER }]],
  ["error/price-zero", [{ type: "max_unit_price", minor: 0 }]],
  ["error/price-unsafe", [{ type: "max_unit_price", minor: Number.MAX_SAFE_INTEGER + 1 }]],
  ["error/return-days-negative", [{ type: "require_return_days", min: -1 }]],
  ["error/merchant-prefix-only", [{ type: "deny_merchant", id: "mrc_" }]],
  ["error/merchant-no-prefix", [{ type: "deny_merchant", id: "runfast" }]],
  ["error/merchant-format-char", [{ type: "deny_merchant", id: "mrc_a​b" }]],
  ["error/merchant-too-long", [{ type: "deny_merchant", id: `mrc_${"a".repeat(125)}` }]],
  ["error/category-leading-zero", [{ type: "deny_category", id: "gpt:01" }]],
  ["error/category-eleven-digits", [{ type: "deny_category", id: "gpt:12345678901" }]],
  [
    "error/second-invalid",
    [
      { type: "deny_category", id: "gpt:1" },
      { type: "deny_category", id: "x" },
    ],
  ],
  [
    "error/too-many",
    Array.from({ length: MAX_EXTRAS + 1 }, () => ({ type: "deny_category", id: "gpt:1" })),
  ],
  ["error/grammar-permit", [{ type: "permit" }]],
  ["error/grammar-extra-member", [{ type: "deny_merchant", id: "mrc_a", effect: "permit" }]],
  ["error/grammar-string-price", [{ type: "max_unit_price", minor: "100" }]],
  ["error/grammar-fraction", [{ type: "max_unit_price", minor: 1.5 }]],
  ["error/grammar-missing-member", [{ type: "deny_category" }]],
  ["error/grammar-no-type", [{ minor: 100 }]],
  ["error/grammar-prototype-name", [{ type: "toString", id: "x" }]],
  ["error/grammar-text", ["permit(principal, action, resource);"]],
];

function outcome(extras: unknown[]): unknown {
  try {
    return compileExtras(parseExtras(extras));
  } catch (e) {
    if (e instanceof TypeError) return { error: "grammar" };
    if (e instanceof ExtrasError) return { error: e.reason, index: e.index };
    throw e;
  }
}

const vectors = cases.map(([name, input]) => ({ name, input, expected: outcome(input) }));
writeFileSync(
  new URL("../test/vectors/extras.json", import.meta.url),
  `${JSON.stringify(vectors, null, 2)}\n`,
);
