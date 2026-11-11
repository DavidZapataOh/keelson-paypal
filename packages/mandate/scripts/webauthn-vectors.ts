// Builds test/vectors/webauthn.json from real passkey assertions. With `--capture`, the API's
// Playwright suite first signs fresh mandates in Chromium with a virtual authenticator and
// writes them to test/vectors/webauthn-captures.json; with `--capture-framed`, Chromium signs
// an embedded mandate in Keelson's approval framed by another site. Otherwise the stored
// captures are reused, so the output is deterministic.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { p256 } from "@noble/curves/nist.js";
import { prepareSigning } from "../src/card.ts";
import { type Mandate, parseMandate } from "../src/schema.ts";
import { decodeMandate } from "../src/sd.ts";
import { EMBED_ORIGIN, RP_ID, spcDetails } from "../src/spc.ts";
import demo from "../test/fixtures/demo-mandate.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const capturesPath = resolve(root, "test/vectors/webauthn-captures.json");

interface Assertion {
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
  credentialId: string;
}
interface Signed {
  payloadSd: Record<string, unknown>;
  disclosures: string[];
  commitment: string;
  assertion: Assertion;
}
interface Captures {
  origin: string;
  rpId: string;
  publicKey: string;
  signed: Record<"payment" | "webauthn" | "shownTotal" | "shownPayee" | "unverified", Signed>;
  /** A mandate signed in the approval at `origin`, framed by `topOrigin`. */
  framed: { origin: string; topOrigin: string; publicKey: string; signed: Signed };
}

const TOP_ORIGIN = "https://agents.example.com";

/**
 * Signs an embedded mandate in Chromium: `TOP_ORIGIN` frames `EMBED_ORIGIN` with the passkey
 * features delegated, and a virtual authenticator creates the passkey and signs in the frame.
 * Playwright serves both pages, so the origins are the production ones.
 */
async function captureFramed(): Promise<Captures["framed"]> {
  const { chromium } = await import("playwright");
  const frame = `<!doctype html><html lang="en"><title>Approve</title><button id="create">Create</button><script>
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const bytes = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
document.getElementById("create").onclick = () => {
  window.created = navigator.credentials.create({ publicKey: {
    challenge: crypto.getRandomValues(new Uint8Array(32)),
    rp: { id: "${RP_ID}", name: "Keelson" },
    user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "user", displayName: "User" },
    pubKeyCredParams: [{ type: "public-key", alg: -7 }],
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  } }).then(async (c) => {
    const spki = c.response.getPublicKey();
    const jwk = await crypto.subtle.exportKey("jwk", await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]));
    return { id: c.id, x: jwk.x, y: jwk.y };
  });
};
window.sign = (challenge, id) => navigator.credentials.get({ publicKey: {
  challenge: bytes(challenge), rpId: "${RP_ID}", userVerification: "required",
  allowCredentials: [{ type: "public-key", id: bytes(id) }],
} }).then((a) => ({
  authenticatorData: b64u(a.response.authenticatorData),
  clientDataJSON: b64u(a.response.clientDataJSON),
  signature: b64u(a.response.signature),
  credentialId: a.id,
}));
</script></html>`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    await context.route(`${TOP_ORIGIN}/`, (r) =>
      r.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html lang="en"><title>Agents</title><iframe title="Keelson" src="${EMBED_ORIGIN}/embed" allow="publickey-credentials-get; publickey-credentials-create"></iframe></html>`,
      }),
    );
    await context.route(`${EMBED_ORIGIN}/embed`, (r) =>
      r.fulfill({
        contentType: "text/html",
        body: frame,
        headers: {
          "permissions-policy":
            "publickey-credentials-get=(self), publickey-credentials-create=(self)",
        },
      }),
    );
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    });
    await page.goto(`${TOP_ORIGIN}/`);
    const inFrame = page.frames().find((f) => f.url().startsWith(EMBED_ORIGIN));
    if (!inFrame) throw new Error("the approval frame did not load");
    // Creating a passkey in a cross-origin frame takes a user activation there.
    await page.frameLocator("iframe").locator("#create").click();
    const cred = (await inFrame.evaluate("window.created")) as { id: string; x: string; y: string };
    const m = structuredClone(demo) as unknown as Mandate;
    m.user.cred = {
      id: cred.id,
      rp_id: RP_ID,
      jwk: { kty: "EC", crv: "P-256", x: cred.x, y: cred.y },
    };
    m.embed = { top_origin: TOP_ORIGIN };
    const s = await prepareSigning(
      m,
      new Uint8Array(16).fill(7),
      { merchantSignedCheckout: false, zkTlsFields: new Set() },
      [],
    );
    const assertion = (await inFrame.evaluate(
      ([challenge, id]) =>
        (window as unknown as { sign(c: string, i: string): Promise<unknown> }).sign(challenge, id),
      [b64u(s.challenge), cred.id] as const,
    )) as Assertion;
    const point = Buffer.concat([Buffer.from([4]), fromB64u(cred.x), fromB64u(cred.y)]);
    return {
      origin: EMBED_ORIGIN,
      topOrigin: TOP_ORIGIN,
      publicKey: coseEc2(point),
      signed: {
        payloadSd: s.payloadSd as Record<string, unknown>,
        disclosures: s.disclosures,
        commitment: s.commitment,
        assertion,
      },
    };
  } finally {
    await browser.close();
  }
}

if (process.argv.includes("--capture")) {
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@keelson/api",
      "exec",
      "vitest",
      "run",
      "test/mandates.test.ts",
      "-t",
      "captures assertions",
    ],
    { stdio: "inherit", env: { ...process.env, KEELSON_CAPTURE_WEBAUTHN: capturesPath } },
  );
}

const fromB64u = (s: string): Buffer => Buffer.from(s, "base64url");
const b64u = (b: Uint8Array): string => Buffer.from(b).toString("base64url");
const coseEc2 = (point: Uint8Array): string =>
  Buffer.concat([
    // {1: 2, 3: -7, -1: 1, -2: x, -3: y} (RFC 9053 section 7.1.1)
    Buffer.from("a5010203262001215820", "hex"),
    point.subarray(1, 33),
    Buffer.from("225820", "hex"),
    point.subarray(33),
  ]).toString("base64");

if (process.argv.includes("--capture-framed")) {
  const stored = JSON.parse(readFileSync(capturesPath, "utf8")) as Captures;
  stored.framed = await captureFramed();
  writeFileSync(capturesPath, `${JSON.stringify(stored, null, 2)}\n`);
}

const captures = JSON.parse(readFileSync(capturesPath, "utf8")) as Captures;
const { signed } = captures;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function publicKeySec1(s: Signed): string {
  const { x, y } = (decodeMandate(s.payloadSd, s.disclosures) as Mandate).user.cred.jwk;
  return `0x04${fromB64u(x).toString("hex")}${fromB64u(y).toString("hex")}`;
}

/** A DER INTEGER for a non-negative value, minimally encoded. */
function derInteger(n: bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  if (Number.parseInt(hex.slice(0, 2), 16) & 0x80) hex = `00${hex}`;
  const body = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.from([0x02, body.length]), body]);
}

/** The same ECDSA signature with `s` replaced by `n - s`, which verifiers without a low-S rule accept. */
function highS(signature: string): string {
  const der = fromB64u(signature);
  const rLen = der[3] as number;
  const r = der.subarray(4, 4 + rLen);
  const s = der.subarray(6 + rLen);
  const highs = P256_N - BigInt(`0x${s.toString("hex")}`);
  const body = Buffer.concat([derInteger(BigInt(`0x${r.toString("hex")}`)), derInteger(highs)]);
  return b64u(Buffer.concat([Buffer.from([0x30, body.length]), body]));
}

const clientData = (a: Assertion): string => fromB64u(a.clientDataJSON).toString("utf8");
const withClientData = (a: Assertion, json: string): Assertion => ({
  ...a,
  clientDataJSON: b64u(Buffer.from(json, "utf8")),
});
function withAuthData(a: Assertion, edit: (b: Buffer) => Buffer): Assertion {
  return { ...a, authenticatorData: b64u(edit(Buffer.from(fromB64u(a.authenticatorData)))) };
}
function setFlags(a: Assertion, edit: (flags: number) => number): Assertion {
  return withAuthData(a, (b) => {
    b[32] = edit(b[32] as number);
    return b;
  });
}

interface PublicKey {
  /** COSE_Key, standard base64, as the passkey table stores it. */
  cose: string;
  /** SEC1, `0x`-prefixed hex. */
  sec1: string;
}

interface VerifyCase {
  /** The assertion; defaults to the capture's own. */
  assertion?: Assertion;
  /** The signed mandate the verifier expects; defaults to the capture. */
  mandate?: Signed;
  origin?: string;
  /** The embedding page the verifier expects, for a mandate signed in a frame. */
  topOrigin?: string;
  rpId?: string;
  /** The passkey the verifier expects; defaults to the captured one. */
  key?: PublicKey;
  /** `rust` for inputs only the Rust verifier can receive. */
  scope?: "rust";
  /** The SPC field a `payment` error names. */
  paymentField?: string;
  source?: "synthetic";
}

function verifyVector(name: string, s: Signed, c: VerifyCase, expected: string) {
  const m = c.mandate ?? s;
  return {
    name: `verify/${name}`,
    ...(c.source && { source: c.source }),
    ...(c.scope && { scope: c.scope }),
    input: {
      op: "verify",
      payloadSd: m.payloadSd,
      disclosures: m.disclosures,
      cm: m.commitment,
      origin: c.origin ?? captures.origin,
      ...(c.topOrigin && { topOrigin: c.topOrigin }),
      rpId: c.rpId ?? captures.rpId,
      publicKey: c.key?.cose ?? captures.publicKey,
      publicKeySec1: c.key?.sec1 ?? publicKeySec1(m),
      assertion: c.assertion ?? s.assertion,
      ...(c.paymentField && { paymentField: c.paymentField }),
    },
    expected,
  };
}

/** A deterministic P-256 key that stands in for the authenticator in synthetic vectors. */
const testSecret = createHash("sha256").update("keelson/vectors/webauthn/key").digest();
const testPoint = p256.getPublicKey(testSecret, false);
const testKey: PublicKey = {
  cose: coseEc2(testPoint),
  sec1: `0x${Buffer.from(testPoint).toString("hex")}`,
};

interface Synthetic {
  /** Edits the parsed client data; return a string to replace the JSON text outright. */
  clientData?: (c: Record<string, unknown>) => string | undefined;
  authData?: (b: Buffer) => Buffer;
}

/**
 * The payment capture's client data and authenticator data with one edit, signed again with the
 * test key so that only the edited check can fail.
 */
function synthetic(name: string, edit: Synthetic, expected: string, extra: VerifyCase = {}) {
  return resigned(`synthetic/${name}`, p, edit, expected, extra);
}

/** `base`'s client data and authenticator data with one edit, signed again with the test key. */
function resigned(
  name: string,
  base: Signed,
  edit: Synthetic,
  expected: string,
  extra: VerifyCase,
) {
  const c = JSON.parse(clientData(base.assertion)) as Record<string, unknown>;
  const json = edit.clientData?.(c) ?? JSON.stringify(c);
  const cdj = Buffer.from(json, "utf8");
  const auth = (edit.authData ?? ((b) => b))(
    Buffer.from(fromB64u(base.assertion.authenticatorData)),
  );
  const hash = createHash("sha256").update(cdj).digest();
  const signature = p256.sign(Buffer.concat([auth, hash]), testSecret, { format: "der" });
  return verifyVector(
    name,
    base,
    {
      ...extra,
      source: "synthetic",
      key: testKey,
      assertion: {
        ...base.assertion,
        clientDataJSON: b64u(cdj),
        authenticatorData: b64u(auth),
        signature: b64u(signature),
      },
    },
    expected,
  );
}

const payment = (c: Record<string, unknown>) =>
  c.payment as Record<string, Record<string, unknown>>;
const flagged = (flags: number, tail: string) => (b: Buffer) => {
  b[32] = (b[32] as number) | flags;
  return Buffer.concat([b, Buffer.from(tail, "hex")]);
};
const set =
  (key: string, value: unknown) =>
  (c: Record<string, unknown>): undefined => {
    c[key] = value;
  };
/** Client data padded with Chrome's filler member to exactly `size` bytes. */
const padded = (size: number) => (c: Record<string, unknown>) => {
  c.other_keys_can_be_added_here = "";
  const pad = size - Buffer.byteLength(JSON.stringify(c));
  c.other_keys_can_be_added_here = "x".repeat(pad);
  return undefined;
};

const { payment: p, webauthn: w } = signed;
const sig = fromB64u(w.assertion.signature);
sig[sig.length - 1] = (sig[sig.length - 1] as number) ^ 1;

const verify: ReturnType<typeof verifyVector>[] = [
  verifyVector("ok/payment.get", p, {}, "ok"),
  verifyVector("ok/webauthn.get", w, {}, "ok"),
  verifyVector(
    "ok/high-s",
    w,
    { assertion: { ...w.assertion, signature: highS(w.assertion.signature) } },
    "ok",
  ),
  verifyVector("error/other-mandate", p, { mandate: w }, "challenge"),
  verifyVector("error/origin", w, { origin: "http://evil.example" }, "origin"),
  verifyVector("error/rp-id", w, { rpId: "evil.example" }, "rp-id"),
  verifyVector("error/user-not-verified", signed.unverified, {}, "user-verified"),
  verifyVector(
    "error/bad-signature",
    w,
    { assertion: { ...w.assertion, signature: b64u(sig) } },
    "signature",
  ),
  verifyVector("error/spc-total-shown", signed.shownTotal, {}, "payment"),
  verifyVector("error/spc-payee-shown", signed.shownPayee, {}, "payment"),
  verifyVector(
    "error/spc-instrument",
    p,
    {
      assertion: withClientData(
        p.assertion,
        clientData(p.assertion).replace('"displayName":"Keelson mandate"', '"displayName":"Card"'),
      ),
    },
    "payment",
  ),
  verifyVector(
    "error/spc-no-payment",
    p,
    {
      assertion: withClientData(
        p.assertion,
        clientData(p.assertion).replace(/,"payment":.*\}$/, "}"),
      ),
    },
    "payment",
  ),
  verifyVector(
    "error/cross-origin",
    p,
    {
      assertion: withClientData(
        p.assertion,
        clientData(p.assertion).replace('"crossOrigin":false', '"crossOrigin":true'),
      ),
    },
    "cross-origin",
  ),
  verifyVector(
    "error/type",
    w,
    {
      assertion: withClientData(
        w.assertion,
        clientData(w.assertion).replace("webauthn.get", "webauthn.create"),
      ),
    },
    "type",
  ),
  verifyVector(
    "error/client-data",
    w,
    { assertion: withClientData(w.assertion, "{") },
    "client-data",
  ),
  verifyVector(
    "error/user-not-present",
    w,
    { assertion: setFlags(w.assertion, (f) => f & ~0x01) },
    "user-present",
  ),
  verifyVector(
    "error/backup-state",
    w,
    { assertion: setFlags(w.assertion, (f) => f | 0x10) },
    "backup-state",
  ),
  verifyVector(
    "error/authenticator-data-trailing",
    w,
    { assertion: withAuthData(w.assertion, (b) => Buffer.concat([b, Buffer.from([0])])) },
    "authenticator-data",
  ),
  verifyVector(
    "error/authenticator-data-short",
    w,
    { assertion: withAuthData(w.assertion, (b) => b.subarray(0, 36)) },
    "authenticator-data",
  ),
];

const spcFields: [string, (c: Record<string, unknown>) => void][] = [
  ["rpId", (c) => (payment(c).rpId = "evil.example" as never)],
  ["topOrigin", (c) => (payment(c).topOrigin = "http://evil.example" as never)],
  ["payeeName", (c) => (payment(c).payeeName = "Someone Else" as never)],
  ["payeeOrigin", (c) => (payment(c).payeeOrigin = "https://evil.example" as never)],
  ["total.currency", (c) => ((payment(c).total as Record<string, unknown>).currency = "EUR")],
  ["total.value", (c) => ((payment(c).total as Record<string, unknown>).value = "0.01")],
  [
    "instrument.displayName",
    (c) => ((payment(c).instrument as Record<string, unknown>).displayName = "Card"),
  ],
  [
    "instrument.icon",
    (c) => ((payment(c).instrument as Record<string, unknown>).icon = "data:image/png;base64,"),
  ],
  [
    "paymentEntitiesLogos",
    (c) =>
      (payment(c).paymentEntitiesLogos = [
        { url: "https://evil.example/l.png", label: "Evil" },
      ] as never),
  ],
  ["paymentEntitiesLogos", (c) => (payment(c).paymentEntitiesLogos = null as never)],
];

const compressed = (sec1: string): string => {
  const point = Buffer.from(sec1.slice(2), "hex");
  const prefix = (point[64] as number) & 1 ? "03" : "02";
  return `0x${prefix}${point.subarray(1, 33).toString("hex")}`;
};

verify.push(
  verifyVector("error/other-public-key", w, { key: testKey }, "signature"),
  verifyVector(
    "error/compressed-public-key",
    w,
    { scope: "rust", key: { cose: captures.publicKey, sec1: compressed(publicKeySec1(w)) } },
    "public-key",
  ),
  verifyVector(
    "error/signature-too-long",
    w,
    {
      assertion: {
        ...w.assertion,
        signature: b64u(Buffer.concat([fromB64u(w.assertion.signature), Buffer.alloc(81)])),
      },
    },
    "signature",
  ),
  synthetic("ok/payment.get", {}, "ok"),
  synthetic(
    "ok/no-logos",
    { clientData: (c) => void delete payment(c).paymentEntitiesLogos },
    "ok",
  ),
  synthetic("ok/client-data-4096-bytes", { clientData: padded(4096) }, "ok"),
  synthetic("error/client-data-4097-bytes", { clientData: padded(4097) }, "client-data"),
  synthetic("error/client-data-array", { clientData: () => "[]" }, "client-data"),
  synthetic("error/client-data-null", { clientData: () => "null" }, "client-data"),
  ...spcFields.map(([field, edit], i) =>
    synthetic(
      `error/spc-${field}${i === spcFields.length - 1 ? "-null" : ""}`,
      { clientData: (c) => void edit(c) },
      "payment",
      {
        paymentField: field,
      },
    ),
  ),
  synthetic("error/cross-origin-null", { clientData: set("crossOrigin", null) }, "cross-origin"),
  synthetic("error/top-origin", { clientData: set("topOrigin", captures.origin) }, "cross-origin"),
  ...[{ status: "present", id: "AAAA" }, { status: "bogus" }, "x", null].map((tokenBinding, i) =>
    synthetic(
      `error/token-binding-${i}`,
      { clientData: set("tokenBinding", tokenBinding) },
      "token-binding",
    ),
  ),
  ...["", "a16178f5", "05", "1805", "f93c00", "4100", "c060"].map((tail) =>
    synthetic(
      `error/extension-data-${tail || "empty"}`,
      { authData: flagged(0x80, tail) },
      "authenticator-data",
    ),
  ),
  synthetic(
    "error/attested-credential-data",
    { authData: flagged(0x40, "") },
    "authenticator-data",
  ),
  synthetic(
    "error/authenticator-data-trailing",
    { authData: flagged(0, "00") },
    "authenticator-data",
  ),
  synthetic(
    "error/authenticator-data-1025-bytes",
    { authData: flagged(0, "00".repeat(1025 - 37)) },
    "authenticator-data",
  ),
);

// A mandate signed in the approval framed by an agent platform: Chromium's capture of
// `webauthn.get`, and `payment.get` as Chromium writes it in a frame (the payment capture's SPC
// data, with `crossOrigin`, `topOrigin` and `payment.topOrigin` naming the platform).
const { framed } = captures;
const f = framed.signed;
const inFrame: VerifyCase = {
  origin: framed.origin,
  topOrigin: framed.topOrigin,
  key: { cose: framed.publicKey, sec1: publicKeySec1(f) },
};
const framedSpc = (c: Record<string, unknown>) => {
  const shown = JSON.parse(clientData(p.assertion)) as Record<string, unknown>;
  const spcShown = spcDetails(decodeMandate(f.payloadSd, f.disclosures) as Mandate);
  c.type = "payment.get";
  delete c.other_keys_can_be_added_here;
  c.payment = {
    ...(shown.payment as Record<string, unknown>),
    topOrigin: framed.topOrigin,
    total: { value: spcShown.total.value, currency: spcShown.total.currency },
  };
};
const framedEdit =
  (...edits: ((c: Record<string, unknown>) => void)[]) =>
  (c: Record<string, unknown>): undefined => {
    for (const edit of edits) edit(c);
  };
verify.push(
  verifyVector("ok/framed-webauthn.get", f, inFrame, "ok"),
  verifyVector(
    "error/framed-at-top-level",
    f,
    { origin: framed.origin, key: inFrame.key as PublicKey },
    "cross-origin",
  ),
  verifyVector(
    "error/framed-other-platform",
    f,
    { ...inFrame, topOrigin: "https://evil.example" },
    "cross-origin",
  ),
  verifyVector("error/framed-app-origin", f, { ...inFrame, origin: captures.origin }, "origin"),
  verifyVector("error/framed-other-mandate", f, { ...inFrame, mandate: w }, "challenge"),
  verifyVector("error/top-level-as-framed", w, { topOrigin: framed.topOrigin }, "cross-origin"),
  resigned(
    "synthetic/ok/framed-payment.get",
    f,
    { clientData: framedEdit(framedSpc) },
    "ok",
    inFrame,
  ),
  resigned(
    "synthetic/error/framed-payment-top-origin",
    f,
    {
      clientData: framedEdit(
        framedSpc,
        (c) => (payment(c).topOrigin = "https://evil.example" as never),
      ),
    },
    "payment",
    { ...inFrame, paymentField: "topOrigin" },
  ),
  ...(
    [
      ["cross-origin-false", set("crossOrigin", false)],
      ["cross-origin-absent", (c) => void delete c.crossOrigin],
      ["cross-origin-string", set("crossOrigin", "true")],
      ["top-origin-absent", (c) => void delete c.topOrigin],
      ["top-origin-slash", set("topOrigin", `${framed.topOrigin}/`)],
      ["top-origin-null", set("topOrigin", null)],
    ] as [string, (c: Record<string, unknown>) => void][]
  ).map(([name, edit]) =>
    resigned(
      `synthetic/error/framed-${name}`,
      f,
      { clientData: framedEdit(edit) },
      "cross-origin",
      inFrame,
    ),
  ),
);

function spcVector(name: string, edit: (m: Record<string, unknown>) => void) {
  const mandate = structuredClone(demo) as Record<string, unknown>;
  edit(mandate);
  let expected: unknown;
  try {
    expected = spcDetails(parseMandate(mandate));
  } catch {
    expected = "error";
  }
  return { name: `spcDetails/${name}`, input: { op: "spcDetails", mandate }, expected };
}

/** Sets the payment currency and both amount caps. */
const money = (currency: string, max: number) => (m: Record<string, unknown>) => {
  const payment = m.payment as { currency: string; constraints: Record<string, unknown>[] };
  payment.currency = currency;
  for (const c of payment.constraints) {
    if ("currency" in c) c.currency = currency;
    if (c.type === "payment.amount_range" || c.type === "payment.budget") c.max = max;
  }
};

const spc = [
  spcVector("demo", () => {}),
  spcVector("usd-cents", money("USD", 1)),
  spcVector("jpy", money("JPY", 12_345)),
  spcVector("huf-whole", money("HUF", 12_300)),
  spcVector("huf-fraction", money("HUF", 12_345)),
];

writeFileSync(
  resolve(root, "test/vectors/webauthn.json"),
  `${JSON.stringify([...verify, ...spc], null, 2)}\n`,
);
