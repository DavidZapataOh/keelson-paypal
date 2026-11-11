import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Hex, keccak256, stringToHex } from "viem";
import { signTypedData } from "viem/accounts";
import {
  CHAIN_IDS,
  type Countersign,
  countersignDigest,
  FIELD_BITS,
  failedFieldsMask,
  hashKeelson,
  KEELSON_TYPES,
  type KeelsonPrimaryType,
  keelsonDomain,
  reportData,
  type SignerBinding,
  TeeKind,
} from "../src/eip712.ts";
import {
  type AlibiFields,
  alibiDigest,
  type Cart,
  CURRENCIES,
  type CurrencyCode,
  cartHash,
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
          else if (type === "bytes2") message[name] = max ? "0xffff" : "0x5553";
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

function cartHashVectors() {
  const shoes: Cart = {
    merchant: "mrc_runfast",
    currency: "USD",
    lines: [
      {
        sku: "sku-trail-10",
        size: "10",
        color: "black",
        category: "gpt:187",
        qty: 1,
        unit_minor: 9400,
      },
    ],
    return_days: 30,
    returns_free: true,
  };
  const bundleLines = [
    {
      sku: "sku-trail-10",
      size: "10",
      color: "black",
      category: "gpt:187",
      qty: 2,
      unit_minor: 9400,
    },
    { sku: "SOCK-6", size: null, color: "white", category: "gpt:1604", qty: 3, unit_minor: 1500 },
    { sku: "BAG-20", size: null, color: null, category: "gpt:100", qty: 1, unit_minor: 10700 },
  ];
  const bundle: Cart = { ...shoes, return_days: 14, returns_free: false, lines: bundleLines };
  const omitted: Cart = {
    ...bundle,
    lines: [
      bundleLines[0] as Cart["lines"][number],
      { sku: "SOCK-6", color: "white", category: "gpt:1604", qty: 3, unit_minor: 1500 },
      { sku: "BAG-20", category: "gpt:100", qty: 1, unit_minor: 10700 },
    ],
  };
  const cases: [string, Cart][] = [
    ["demo-shoes", shoes],
    ["bundle-nulls", bundle],
    ["bundle-omitted", omitted],
    [
      "unicode",
      {
        ...shoes,
        merchant: "mrc_zapatería",
        lines: [
          {
            sku: "zapato-ñ-\u{1F45F}",
            size: "42",
            color: "rojo",
            category: "gpt:187",
            qty: 1,
            unit_minor: 0,
          },
        ],
      },
    ],
    [
      "variants",
      {
        ...shoes,
        lines: [
          {
            sku: "sku-trail-10",
            size: "9",
            color: "black",
            category: "gpt:187",
            qty: 1,
            unit_minor: 9400,
          },
          {
            sku: "sku-trail-10",
            size: "10",
            color: "black",
            category: "gpt:187",
            qty: 1,
            unit_minor: 9400,
          },
        ],
      },
    ],
    [
      "jpy-large",
      {
        merchant: "mrc_tokyo",
        currency: "JPY",
        lines: [
          {
            sku: "k",
            size: null,
            color: null,
            category: "gpt:1",
            qty: 999,
            unit_minor: 9_007_199_254,
          },
        ],
        return_days: 0,
        returns_free: false,
      },
    ],
  ];
  return cases.map(([name, cart]) => ({ name, input: cart, expected: toHex(cartHash(cart)) }));
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

const UINT40_MAX = (1n << 40n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;
const ONES = `0x${"ff".repeat(32)}` as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

async function countersignVectors() {
  const privateKey = keccak256(stringToHex("keelson/test/countersign-signer"));
  const base: Countersign = {
    requestId: field(0x0192f3a1b2c3d4e5f60718293a4b5c6dn),
    mandateHash: field(0x11n),
    mandateCommitment: field(0x22n),
    cartHash: field(0x33n),
    agentId: 7n,
    merchantId: field(0x44n),
    amount: 9400n,
    currency: 840,
    category: 3,
    evidenceRoot: field(0x55n),
    evalHash: field(0x66n),
    policySetHash: field(0x77n),
    decision: 1,
    failedFieldsMask: 0,
    issuedAt: 1_762_400_000,
    expiresAt: 1_762_400_900,
  };
  const deny = (mask: number) => ({ decision: 2, failedFieldsMask: mask });
  const cases: { name: string; chainId: 421614 | 42161; contract: Hex; patch: object }[] = [
    { name: "allow", chainId: 421614, contract: ZERO_ADDRESS, patch: {} },
    { name: "allow/contract", chainId: 421614, contract: ADDRESSES[0] as Hex, patch: {} },
    { name: "allow/arbitrum-one", chainId: 42161, contract: ADDRESSES[1] as Hex, patch: {} },
    { name: "deny/amount", chainId: 421614, contract: ZERO_ADDRESS, patch: deny(1 << 3) },
    { name: "deny/amount-variant", chainId: 421614, contract: ZERO_ADDRESS, patch: deny(0x208) },
    { name: "deny/all-fields", chainId: 421614, contract: ZERO_ADDRESS, patch: deny(0xfff) },
    { name: "deny/canon", chainId: 421614, contract: ZERO_ADDRESS, patch: deny(1 << 29) },
    { name: "deny/cedar-error", chainId: 421614, contract: ZERO_ADDRESS, patch: deny(1 << 30) },
    { name: "deny/paypal", chainId: 421614, contract: ZERO_ADDRESS, patch: deny(2 ** 31) },
    {
      name: "deny/all-ones-mask",
      chainId: 421614,
      contract: ZERO_ADDRESS,
      patch: deny(2 ** 32 - 1),
    },
    {
      name: "uint40-max",
      chainId: 421614,
      contract: ZERO_ADDRESS,
      patch: { issuedAt: UINT40_MAX, expiresAt: UINT40_MAX },
    },
    { name: "uint64-max", chainId: 421614, contract: ZERO_ADDRESS, patch: { amount: UINT64_MAX } },
    {
      name: "uint256-max",
      chainId: 421614,
      contract: ZERO_ADDRESS,
      patch: { agentId: UINT256_MAX },
    },
    { name: "category-mixed", chainId: 421614, contract: ZERO_ADDRESS, patch: { category: 255 } },
    { name: "currency-jpy", chainId: 421614, contract: ZERO_ADDRESS, patch: { currency: 392 } },
    { name: "currency-max", chainId: 421614, contract: ZERO_ADDRESS, patch: { currency: 65535 } },
    { name: "amount-zero", chainId: 421614, contract: ZERO_ADDRESS, patch: { amount: 0n } },
    {
      name: "bytes32-ones",
      chainId: 421614,
      contract: ADDRESSES[2] as Hex,
      patch: {
        requestId: ONES,
        mandateHash: ONES,
        mandateCommitment: ONES,
        cartHash: ONES,
        merchantId: ONES,
        evidenceRoot: ONES,
        evalHash: ONES,
        policySetHash: ONES,
      },
    },
    {
      name: "all-max",
      chainId: 42161,
      contract: ADDRESSES[2] as Hex,
      patch: {
        requestId: ONES,
        mandateHash: ONES,
        mandateCommitment: ONES,
        cartHash: ONES,
        agentId: UINT256_MAX,
        merchantId: ONES,
        amount: UINT64_MAX,
        currency: 65535,
        category: 255,
        evidenceRoot: ONES,
        evalHash: ONES,
        policySetHash: ONES,
        decision: 255,
        failedFieldsMask: 2 ** 32 - 1,
        issuedAt: UINT40_MAX,
        expiresAt: UINT40_MAX,
      },
    },
    {
      name: "all-zero",
      chainId: 421614,
      contract: ZERO_ADDRESS,
      patch: Object.fromEntries(
        KEELSON_TYPES.Countersign.map(({ name, type }) => [
          name,
          type === "bytes32" ? field(0n) : type === "uint256" || type === "uint64" ? 0n : 0,
        ]),
      ),
    },
  ];
  const vectors = [];
  for (const { name, chainId, contract, patch } of cases) {
    const message = { ...base, ...patch } as Countersign;
    const domain = keelsonDomain(chainId, contract);
    vectors.push({
      name,
      input: {
        domain,
        message: Object.fromEntries(
          Object.entries(message).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]),
        ),
        privateKey,
      },
      expected: {
        digest: countersignDigest(message, domain),
        signature: await signTypedData({
          privateKey,
          domain,
          types: KEELSON_TYPES,
          primaryType: "Countersign",
          message,
        }),
      },
    });
  }
  return vectors;
}

function reportDataVectors() {
  const base: SignerBinding = {
    chainId: 421614n,
    bondVault: ZERO_ADDRESS,
    teeKind: TeeKind.TDX,
    signer: ADDRESSES[1] as Hex,
    policySetHash: field(0x77n),
    engineBuildId: keccak256(stringToHex("oci-digest")),
    bootEpoch: 1_762_400_000n,
    issuerJwkThumbprint: keccak256(stringToHex("issuer-jwk")),
  };
  const cases: { name: string; binding: SignerBinding; blockHash: Hex }[] = [
    { name: "tdx/zero-vault", binding: base, blockHash: field(0xb10cn) },
    {
      name: "nitro/zero-vault",
      binding: { ...base, teeKind: TeeKind.NITRO },
      blockHash: field(0xb10cn),
    },
    {
      name: "tdx/deployed-vault",
      binding: { ...base, bondVault: ADDRESSES[0] as Hex },
      blockHash: keccak256(stringToHex("block")),
    },
    {
      name: "tdx/other-issuer",
      binding: { ...base, issuerJwkThumbprint: field(0x155n) },
      blockHash: field(0xb10cn),
    },
    {
      name: "nitro/arbitrum-one",
      binding: { ...base, chainId: 42161n, teeKind: TeeKind.NITRO, bondVault: ADDRESSES[1] as Hex },
      blockHash: ONES,
    },
    {
      name: "max",
      binding: {
        chainId: 42161n,
        bondVault: ADDRESSES[2] as Hex,
        teeKind: TeeKind.NITRO,
        signer: ADDRESSES[2] as Hex,
        policySetHash: ONES,
        engineBuildId: ONES,
        bootEpoch: UINT64_MAX,
        issuerJwkThumbprint: ONES,
      },
      blockHash: ONES,
    },
  ];
  const bad = (patch: object) => ({ ...base, ...patch }) as SignerBinding;
  cases.push(
    { name: "error/chain-1", binding: bad({ chainId: 1n }), blockHash: ONES },
    { name: "error/chain-u64-max", binding: bad({ chainId: UINT64_MAX }), blockHash: ONES },
    { name: "error/tee-kind-0", binding: bad({ teeKind: 0 }), blockHash: ONES },
    { name: "error/tee-kind-3", binding: bad({ teeKind: 3 }), blockHash: ONES },
  );
  return cases.map(({ name, binding, blockHash }) => {
    let expected: string;
    try {
      expected = reportData(binding, blockHash);
    } catch {
      expected = "error";
    }
    return {
      name,
      input: {
        binding: {
          ...binding,
          chainId: String(binding.chainId),
          bootEpoch: String(binding.bootEpoch),
        },
        blockHash,
      },
      expected,
    };
  });
}

function failedFieldsMaskVectors() {
  const cases: {
    name: string;
    fired: string[];
    errors?: boolean;
    canon?: boolean;
    paypal?: boolean;
  }[] = [
    { name: "none", fired: [] },
    { name: "base-only", fired: ["base"] },
    { name: "amount-variant", fired: ["amount", "variant"] },
    { name: "all-fields", fired: Object.keys(FIELD_BITS) },
    { name: "extra", fired: ["extra.0"] },
    { name: "extras-and-field", fired: ["extra.0", "extra.3", "window"] },
    { name: "canon", fired: [], canon: true },
    { name: "cedar-error", fired: ["agent"], errors: true },
    { name: "paypal", fired: [], paypal: true },
    {
      name: "everything",
      fired: [...Object.keys(FIELD_BITS), "extra.1"],
      errors: true,
      canon: true,
      paypal: true,
    },
  ];
  return cases.map(({ name, fired, errors = false, canon = false, paypal = false }) => ({
    name,
    input: { fired, errors, canon, paypal },
    expected: failedFieldsMask(fired, { errors, canon, paypal }),
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
writeJson("cart-hash", cartHashVectors());
writeJson("field-from-ascii", fieldFromAsciiVectors());
writeJson("countersign", await countersignVectors());
writeJson("report-data", reportDataVectors());
writeJson("failed-fields-mask", failedFieldsMaskVectors());
write(noirFile, noirSource(poseidon));
