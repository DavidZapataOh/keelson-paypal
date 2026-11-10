import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    APP_ORIGIN: z.url(),
    VERIFY_ORIGIN: z
      .url()
      .refine((u) => new URL(u).origin === u, "VERIFY_ORIGIN must be an origin")
      .default("https://verify.keelson.finance"),
    PAYPAL_CLIENT_ID: z.string().min(1),
    PAYPAL_CLIENT_SECRET: z.string().min(1),
    PAYPAL_ENV: z.enum(["sandbox", "production"]),
    /** The payer id of the account the PayPal credentials belong to; holds are payable only to it. */
    PAYPAL_MERCHANT_ID: z.string().min(1),
    /** The id of the webhook PayPal delivers to; deliveries are verified against it. */
    PAYPAL_WEBHOOK_ID: z
      .string()
      .regex(/^[A-Z0-9]{1,50}$/)
      .optional(),
    PASSKEY_RP_ID: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    TEE_A_URL: z.url().optional(),
    TEE_B_URL: z.url().optional(),
    KEELSON_TEE_TOKEN: z.string().min(32).optional(),
    KEELSON_ISSUER_THUMBPRINT: z
      .custom<`0x${string}`>((v) => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v))
      .optional(),
    ARBITRUM_SEPOLIA_RPC_URL: z.url().optional(),
    /** Registers the legs' signers in the VerdictVerifier; without it signers are admitted off-chain only. */
    KEELSON_REGISTRAR_KEY: z
      .custom<`0x${string}`>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v))
      .optional(),
    /** The demo operator's key: Keelson signs that operator's `Coverage`, and no other's. */
    KEELSON_OPERATOR_KEY: z
      .custom<`0x${string}`>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v))
      .optional(),
    DEMO_AGENT_ID: z.coerce.bigint().positive().optional(),
    /** Keelson's treasury key: it pays in PYUSD the verdicts the chain refuses although they hold. */
    KEELSON_TREASURY_KEY: z
      .custom<`0x${string}`>((v) => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v))
      .optional(),
    ARBITRUM_ONE_RPC_URL: z.url().optional(),
    /** KMS key ids of the relayer's senders; each needs its chain's RPC URL and the relayer's AWS key. */
    RELAYER_KMS_KEY_SANDBOX: z.string().min(1).optional(),
    RELAYER_KMS_KEY_LIVE: z.string().min(1).optional(),
    RELAYER_AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
    RELAYER_AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    AWS_REGION: z.string().min(1).default("us-west-2"),
    LOG_URL: z.url().optional(),
    LOG_WRITE_TOKEN: z.string().min(32).optional(),
    KEELSON_EVIDENCE_AGE_IDENTITY: z.string().startsWith("AGE-SECRET-KEY-").optional(),
    KEELSON_EVIDENCE_AGE_RECIPIENT: z.string().startsWith("age1").optional(),
    CHANNEL3_API_KEY: z.string().min(1).optional(),
    CHANNEL3_WEBHOOK_SECRET: z.string().startsWith("whsec_").optional(),
    TSA_DIGICERT_URL: z.url().optional(),
    TSA_SIGSTORE_URL: z.url().optional(),
    TSA_FREETSA_URL: z.url().optional(),
    TSA_SECTIGO_URL: z.url().optional(),
    /** With both set, disputes are evaluated on the Render workflow whose slug is `DISPUTE_WORKFLOW`. */
    RENDER_API_KEY: z.string().startsWith("rnd_").optional(),
    DISPUTE_WORKFLOW: z
      .string()
      .regex(/^[a-z0-9-]+$/)
      .optional(),
    PORT: z.coerce.number().int().positive().default(10000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.BETTER_AUTH_URL.startsWith("https://"), {
    message: "BETTER_AUTH_URL must use https in production",
    path: ["BETTER_AUTH_URL"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.APP_ORIGIN.startsWith("https://"), {
    message: "APP_ORIGIN must use https in production",
    path: ["APP_ORIGIN"],
  })
  .refine(
    (env) =>
      [env.TEE_A_URL, env.TEE_B_URL, env.KEELSON_TEE_TOKEN].every((v) => v === undefined) ||
      [env.TEE_A_URL, env.TEE_B_URL, env.KEELSON_TEE_TOKEN].every((v) => v !== undefined),
    { message: "TEE_A_URL, TEE_B_URL and KEELSON_TEE_TOKEN are set together", path: ["TEE_A_URL"] },
  )
  .refine((env) => (env.KEELSON_OPERATOR_KEY === undefined) === (env.DEMO_AGENT_ID === undefined), {
    message: "KEELSON_OPERATOR_KEY and DEMO_AGENT_ID are set together",
    path: ["KEELSON_OPERATOR_KEY"],
  })
  .refine((env) => (env.LOG_URL === undefined) === (env.LOG_WRITE_TOKEN === undefined), {
    message: "LOG_URL and LOG_WRITE_TOKEN are set together",
    path: ["LOG_URL"],
  })
  .refine(
    (env) =>
      (env.KEELSON_EVIDENCE_AGE_IDENTITY === undefined) ===
      (env.KEELSON_EVIDENCE_AGE_RECIPIENT === undefined),
    {
      message: "KEELSON_EVIDENCE_AGE_IDENTITY and KEELSON_EVIDENCE_AGE_RECIPIENT are set together",
      path: ["KEELSON_EVIDENCE_AGE_IDENTITY"],
    },
  )
  .refine((env) => env.NODE_ENV !== "production" || env.TEE_A_URL !== undefined, {
    message: "the TEE legs are required in production",
    path: ["TEE_A_URL"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.PAYPAL_WEBHOOK_ID !== undefined, {
    message: "PAYPAL_WEBHOOK_ID is required in production",
    path: ["PAYPAL_WEBHOOK_ID"],
  })
  .refine((env) => env.NODE_ENV !== "production" || env.KEELSON_ISSUER_THUMBPRINT !== undefined, {
    message: "KEELSON_ISSUER_THUMBPRINT is required in production",
    path: ["KEELSON_ISSUER_THUMBPRINT"],
  })
  // The webhook secret comes from Channel3's portal once the endpoint is registered; until then
  // the webhook answers 503 and decisions still get their lookup.
  .refine((env) => env.NODE_ENV !== "production" || env.CHANNEL3_API_KEY !== undefined, {
    message: "CHANNEL3_API_KEY is required in production",
    path: ["CHANNEL3_API_KEY"],
  })
  .refine(
    (env) =>
      (env.RELAYER_AWS_ACCESS_KEY_ID === undefined) ===
      (env.RELAYER_AWS_SECRET_ACCESS_KEY === undefined),
    {
      message: "RELAYER_AWS_ACCESS_KEY_ID and RELAYER_AWS_SECRET_ACCESS_KEY are set together",
      path: ["RELAYER_AWS_ACCESS_KEY_ID"],
    },
  )
  .refine(
    (env) =>
      env.RELAYER_KMS_KEY_SANDBOX === undefined ||
      (env.ARBITRUM_SEPOLIA_RPC_URL !== undefined && env.RELAYER_AWS_ACCESS_KEY_ID !== undefined),
    {
      message: "RELAYER_KMS_KEY_SANDBOX needs ARBITRUM_SEPOLIA_RPC_URL and the relayer's AWS key",
      path: ["RELAYER_KMS_KEY_SANDBOX"],
    },
  )
  .refine(
    (env) =>
      env.RELAYER_KMS_KEY_LIVE === undefined ||
      (env.ARBITRUM_ONE_RPC_URL !== undefined && env.RELAYER_AWS_ACCESS_KEY_ID !== undefined),
    {
      message: "RELAYER_KMS_KEY_LIVE needs ARBITRUM_ONE_RPC_URL and the relayer's AWS key",
      path: ["RELAYER_KMS_KEY_LIVE"],
    },
  )
  .refine((env) => env.PASSKEY_RP_ID === undefined || env.NODE_ENV === "test", {
    message: "PASSKEY_RP_ID may only be set in tests",
    path: ["PASSKEY_RP_ID"],
  });

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
