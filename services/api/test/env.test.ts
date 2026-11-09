import { expect, test } from "vitest";
import { parseEnv } from "../src/env.ts";

const base = {
  DATABASE_URL: "postgres://localhost/keelson",
  REDIS_URL: "redis://localhost:6379",
  BETTER_AUTH_SECRET: "s".repeat(32),
  APP_ORIGIN: "http://localhost:3000",
  PAYPAL_CLIENT_ID: "client",
  PAYPAL_CLIENT_SECRET: "secret",
  PAYPAL_ENV: "sandbox",
  PAYPAL_MERCHANT_ID: "A4WCRYD5EYDF2",
};
const production = {
  ...base,
  TEE_A_URL: "https://tee-a.example",
  TEE_B_URL: "https://tee-b.example",
  KEELSON_TEE_TOKEN: "t".repeat(64),
  KEELSON_ISSUER_THUMBPRINT: `0x${"ab".repeat(32)}`,
  CHANNEL3_API_KEY: "channel3-key",
  NODE_ENV: "production",
  BETTER_AUTH_URL: "https://api.keelson.finance",
  APP_ORIGIN: "https://app.keelson.finance",
};

test("production requires an https auth URL", () => {
  expect(() =>
    parseEnv({ ...production, BETTER_AUTH_URL: "http://api.keelson.finance" }),
  ).toThrow();
  expect(parseEnv(production).BETTER_AUTH_URL).toBe("https://api.keelson.finance");
});

test("development accepts an http auth URL", () => {
  expect(parseEnv({ ...base, BETTER_AUTH_URL: "http://localhost:10000" }).NODE_ENV).toBe(
    "development",
  );
});

test("production requires an https app origin", () => {
  expect(() => parseEnv({ ...production, APP_ORIGIN: "http://app.keelson.finance" })).toThrow();
  expect(parseEnv(production).APP_ORIGIN).toBe("https://app.keelson.finance");
});

test("the passkey RP ID can only be overridden in tests", () => {
  const env = { ...base, BETTER_AUTH_URL: "http://localhost:10000", PASSKEY_RP_ID: "localhost" };
  expect(parseEnv({ ...env, NODE_ENV: "test" }).PASSKEY_RP_ID).toBe("localhost");
  expect(() => parseEnv({ ...env, NODE_ENV: "development" })).toThrow();
  expect(() => parseEnv({ ...production, PASSKEY_RP_ID: "localhost" })).toThrow();
});

test("PayPal sign-in needs credentials and a known environment", () => {
  const env = { ...base, BETTER_AUTH_URL: "http://localhost:10000" };
  expect(() => parseEnv({ ...env, PAYPAL_CLIENT_ID: undefined })).toThrow();
  expect(() => parseEnv({ ...env, PAYPAL_MERCHANT_ID: undefined })).toThrow();
  expect(() => parseEnv({ ...env, PAYPAL_ENV: "live" })).toThrow();
  expect(parseEnv({ ...env, PAYPAL_ENV: "production" }).PAYPAL_ENV).toBe("production");
});

test("the TEE settings come together and are required in production", () => {
  const dev = { ...base, BETTER_AUTH_URL: "http://localhost:10000" };
  expect(parseEnv(dev).TEE_A_URL).toBeUndefined();
  expect(() => parseEnv({ ...dev, TEE_A_URL: "https://tee-a.example" })).toThrow();
  const { TEE_A_URL: _a, ...withoutLegs } = production;
  expect(() => parseEnv(withoutLegs)).toThrow();
});

test("production pins the credential issuer", () => {
  const { KEELSON_ISSUER_THUMBPRINT: _pin, ...unpinned } = production;
  expect(() => parseEnv(unpinned)).toThrow(/KEELSON_ISSUER_THUMBPRINT/);
  expect(() => parseEnv({ ...production, KEELSON_ISSUER_THUMBPRINT: "0x12" })).toThrow();
  expect(parseEnv(production).KEELSON_ISSUER_THUMBPRINT).toBe(`0x${"ab".repeat(32)}`);
});

test("the log's address and write token come together", () => {
  const dev = { ...base, BETTER_AUTH_URL: "http://localhost:10000" };
  expect(() => parseEnv({ ...dev, LOG_URL: "http://keelson-log:8081" })).toThrow();
  expect(() => parseEnv({ ...dev, LOG_WRITE_TOKEN: "w".repeat(48) })).toThrow();
  expect(
    parseEnv({ ...dev, LOG_URL: "http://keelson-log:8081", LOG_WRITE_TOKEN: "w".repeat(48) })
      .LOG_URL,
  ).toBe("http://keelson-log:8081");
});

test("the evidence identity and recipient are set together", () => {
  const dev = { ...base, BETTER_AUTH_URL: "http://localhost:10000" };
  const identity = "AGE-SECRET-KEY-PQ-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ";
  const recipient = "age1pq1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
  expect(() => parseEnv({ ...dev, KEELSON_EVIDENCE_AGE_IDENTITY: identity })).toThrow();
  expect(() => parseEnv({ ...dev, KEELSON_EVIDENCE_AGE_RECIPIENT: recipient })).toThrow();
  expect(
    parseEnv({
      ...dev,
      KEELSON_EVIDENCE_AGE_IDENTITY: identity,
      KEELSON_EVIDENCE_AGE_RECIPIENT: recipient,
    }).KEELSON_EVIDENCE_AGE_RECIPIENT,
  ).toBe(recipient);
});

test("production requires a Channel3 key; the webhook secret is a whsec_ secret", () => {
  const { CHANNEL3_API_KEY: _, ...withoutKey } = production;
  expect(() => parseEnv(withoutKey)).toThrow();
  expect(() => parseEnv({ ...production, CHANNEL3_WEBHOOK_SECRET: "secret" })).toThrow();
  expect(
    parseEnv({ ...production, CHANNEL3_WEBHOOK_SECRET: "whsec_c2VjcmV0" }).CHANNEL3_WEBHOOK_SECRET,
  ).toBe("whsec_c2VjcmV0");
});
