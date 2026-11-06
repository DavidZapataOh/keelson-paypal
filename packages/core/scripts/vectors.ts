import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAIN_IDS,
  hashKeelson,
  KEELSON_TYPES,
  type KeelsonPrimaryType,
  keelsonDomain,
} from "../src/eip712.ts";
import {
  type AlibiFields,
  alibiDigest,
  CURRENCIES,
  type CurrencyCode,
  currencyNumeric,
  DST,
  type Dst,
  fromPayPalValue,
  hashObject,
  type Json,
  jcs,
  toHex,
  toPayPalValue,
} from "../src/index.ts";
import { fieldFromAscii, KEELSON_MANDATE, poseidon2 } from "../src/poseidon2.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vectorsDir = resolve(root, "test/vectors");
const noirFile = resolve(root, "../../circuits/vectors/src/main.nr");

const FIELD_MODULUS =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function write(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function jcsRawVectors() {
  const sources = [
    "1.0",
    "1e3",
    "-0",
    "-0.0",
    "[1.0,2e0,-0.0,1E2]",
    '{"a":1.50}',
    "1.5",
    "9007199254740991",
    "-9007199254740991",
    "9007199254740992",
    "-9007199254740992",
    "9223372036854775807",
    "-9223372036854775808",
    "18446744073709551615",
    "1e300",
    "9007199254740992.0",
  ];
  return sources.map((source) => {
    let expected: string;
    try {
      expected = jcs(JSON.parse(source) as Json);
    } catch {
      expected = "error";
    }
    return { name: source, input: source, expected };
  });
}

function writeJson(name: string, vectors: unknown): void {
  write(resolve(vectorsDir, `${name}.json`), `${JSON.stringify(vectors, null, 2)}\n`);
}

const field = (n: bigint): `0x${string}` => `0x${n.toString(16).padStart(64, "0")}`;

function hashVectors() {
  const cases: { name: string; dst: Dst; value: Json }[] = [];
  for (const [label, dst] of Object.entries(DST)) {
    cases.push({
      name: `${label}/flat`,
      dst,
      value: { zeta: 1, alpha: "a", mid: true, none: null },
    });
    cases.push({
      name: `${label}/nested-unicode`,
      dst,
      value: {
        merchant: { name: "Café Ñandú 東京", tags: ["€", "😀", "\u0000"] },
        lines: [
          { sku: "A-1", qty: 2 },
          { sku: "B-2", qty: 10 },
        ],
        note: 'line\nbreak "quoted" back\\slash',
      },
    });
  }
  cases.push({
    name: "control-escapes",
    dst: DST.cart,
    value: { s: "\b\f\t\u001f\u007f\u2028\u2029\u0085" },
  });
  cases.push({
    name: "utf16-key-order",
    dst: DST.cart,
    value: { "\u{1F600}": 1, "\uFF5E": 2, "\uE000": 3, a: 4 },
  });
  cases.push({ name: "empty-object", dst: DST.cart, value: {} });
  cases.push({ name: "empty-array", dst: DST.cart, value: [] });
  cases.push({ name: "null", dst: DST.eval, value: null });
  cases.push({ name: "max-safe-integer", dst: DST.mandate, value: { n: Number.MAX_SAFE_INTEGER } });
  cases.push({ name: "negative-zero-and-ints", dst: DST.verdict, value: [-0, 0, -1, 1e3] });
  cases.push({ name: "key-order", dst: DST.alibi, value: { b: 2, a: 1, é: 3, "10": 4, "9": 5 } });
  return cases.map(({ name, dst, value }) => ({
    name,
    input: { dst, value },
    expected: toHex(hashObject(dst, value)),
  }));
}

const ADDRESSES = [
  "0x0000000000000000000000000000000000000001",
  "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
  "0xffffffffffffffffffffffffffffffffffffffff",
];

function eip712Vectors() {
  const vectors: { name: string; input: unknown; expected: string }[] = [];
  const chains = [CHAIN_IDS.arbitrumSepolia, CHAIN_IDS.arbitrumOne] as const;
  for (const chainId of chains) {
    const max = chainId === CHAIN_IDS.arbitrumOne;
    const verifyingContract = ADDRESSES[max ? 1 : 0] as `0x${string}`;
    for (const primaryType of Object.keys(KEELSON_TYPES) as KeelsonPrimaryType[]) {
      const message: Record<string, string> = {};
      KEELSON_TYPES[primaryType].forEach(
        ({ name, type }: { name: string; type: string }, index: number) => {
          if (type === "bytes32") message[name] = field(BigInt(index + 1) * 0x0101010101010101n);
          else if (type === "address")
            message[name] = ADDRESSES[(index + (max ? 1 : 0)) % 3] as string;
          else {
            const bits = BigInt(type.slice("uint".length));
            message[name] = (
              max ? (1n << bits) - 1n : BigInt(index + 1) * (bits >= 32n ? 1_000_000n : 7n)
            ).toString();
          }
        },
      );
      const typed: Record<string, unknown> = {};
      for (const { name, type } of KEELSON_TYPES[primaryType]) {
        const raw = message[name] as string;
        typed[name] = type.startsWith("uint") ? BigInt(raw) : raw;
      }
      vectors.push({
        name: `${primaryType}/${chainId}`,
        input: { chainId, verifyingContract, primaryType, message },
        expected: hashKeelson(
          primaryType,
          typed as never,
          keelsonDomain(chainId, verifyingContract),
        ),
      });
    }
  }
  return vectors;
}

async function poseidon2Vectors() {
  const sample = (length: number, offset: bigint) =>
    Array.from(
      { length },
      (_, i) =>
        (BigInt(i + 1) * 0x9e3779b97f4a7c15f39cc0605cedc834n * (offset + 1n)) % FIELD_MODULUS,
    );
  const cases: { name: string; inputs: bigint[] }[] = [];
  for (let length = 0; length <= 10; length++) {
    cases.push({ name: `len-${length}`, inputs: length === 2 ? [1n, 2n] : sample(length, 0n) });
  }
  cases.push({ name: "mandate-commitment", inputs: [KEELSON_MANDATE, ...sample(9, 7n)] });
  const vectors = [];
  for (const { name, inputs } of cases) {
    vectors.push({
      name,
      input: inputs.map(field),
      expected: field(await poseidon2(inputs)),
    });
  }
  return vectors;
}

function moneyVectors() {
  const vectors: { name: string; input: unknown; expected: string }[] = [];
  const attempt = (fn: () => string) => {
    try {
      return fn();
    } catch {
      return "error";
    }
  };
  const minors = [0n, 1n, 9n, 10n, 100n, 9400n, 123456789n, -1n, -9400n];
  for (const currency of Object.keys(CURRENCIES) as CurrencyCode[]) {
    for (const minor of [9400n, 5n]) {
      vectors.push({
        name: `to/${currency}/${minor}`,
        input: { op: "toPayPalValue", currency, minor: minor.toString() },
        expected: attempt(() => toPayPalValue({ currency, minor })),
      });
    }
  }
  for (const minor of minors) {
    vectors.push({
      name: `to/USD/${minor}`,
      input: { op: "toPayPalValue", currency: "USD", minor: minor.toString() },
      expected: toPayPalValue({ currency: "USD", minor }),
    });
  }
  const parses: [CurrencyCode, string][] = [
    ["USD", "94.00"],
    ["USD", "94.5"],
    ["USD", "94"],
    ["USD", "0.01"],
    ["USD", "-0.50"],
    ["USD", "94.001"],
    ["USD", "-0"],
    ["USD", "01.00"],
    ["USD", ".5"],
    ["USD", "1e3"],
    ["JPY", "94"],
    ["JPY", "94.0"],
    ["HUF", "1000"],
    ["HUF", "1000.5"],
    ["TWD", "300"],
    ["EUR", "12345678901234567890.12"],
  ];
  for (const currency of [...Object.keys(CURRENCIES), "XXX", "usd", ""]) {
    vectors.push({
      name: `numeric/${currency}`,
      input: { op: "currencyNumeric", currency },
      expected: attempt(() => currencyNumeric(currency as CurrencyCode).toString()),
    });
  }
  for (const [currency, value] of parses) {
    vectors.push({
      name: `from/${currency}/${value}`,
      input: { op: "fromPayPalValue", currency, value },
      expected: attempt(() => fromPayPalValue(currency, value).minor.toString()),
    });
  }
  return vectors;
}

function fieldFromAsciiVectors() {
  const tags = [
    "KEELSON_MANDATE",
    "KEELSON_MERCHANT",
    "A",
    "\u0000A",
    "ab\u0000",
    "\u007f",
    "x".repeat(31),
    "x".repeat(32),
    "",
    "é",
    "😀",
  ];
  return tags.map((tag) => {
    let expected: string;
    try {
      expected = field(fieldFromAscii(tag));
    } catch {
      expected = "error";
    }
    return { name: `fieldFromAscii/${JSON.stringify(tag)}`, input: tag, expected };
  });
}

function alibiVectors() {
  const base: AlibiFields = {
    mandateHash: field(0x11n),
    cartHash: field(0x22n),
    policySetHash: field(0x33n),
    countersignDigest: field(0x44n),
    merchantId: "MERCHANT1",
    amount: { currency: "USD", minor: 1000n },
  };
  const cases: { name: string; fields: AlibiFields }[] = [
    { name: "without-order", fields: base },
    { name: "with-order", fields: { ...base, paypalOrderId: "5O190127TN364715T" } },
    {
      name: "jpy-with-order",
      fields: {
        ...base,
        merchantId: "7Z9X3ABC5DEFG",
        amount: { currency: "JPY", minor: 9400n },
        paypalOrderId: "8MC585209K746392H",
      },
    },
    {
      name: "unicode-merchant",
      fields: { ...base, merchantId: "Café Ñandú", amount: { currency: "EUR", minor: 5n } },
    },
  ];
  return cases.map(({ name, fields }) => ({
    name,
    input: { ...fields, amount: { ...fields.amount, minor: fields.amount.minor.toString() } },
    expected: toHex(alibiDigest(fields)),
  }));
}

function noirSource(vectors: { name: string; input: string[]; expected: string }[]): string {
  const tests = vectors.map(({ name, input, expected }) => {
    const id = name.replaceAll("-", "_");
    return `#[test]
fn poseidon2_${id}() {
    let input: [Field; ${input.length}] = [${input.join(", ")}];
    assert_eq(Poseidon2::hash(input, ${input.length}), ${expected});
}
`;
  });
  return `// Generated by packages/core/scripts/vectors.ts. Do not edit.
use poseidon::poseidon2::Poseidon2;

fn main() {}

${tests.join("\n")}`;
}

const poseidon = await poseidon2Vectors();
writeJson("hash", hashVectors());
writeJson("jcs-raw", jcsRawVectors());
writeJson("eip712", eip712Vectors());
writeJson("poseidon2", poseidon);
writeJson("money", moneyVectors());
writeJson("alibi", alibiVectors());
writeJson("field-from-ascii", fieldFromAsciiVectors());
write(noirFile, noirSource(poseidon));
