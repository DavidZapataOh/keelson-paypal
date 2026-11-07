import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    APP_ORIGIN: z.url(),
    PAYPAL_CLIENT_ID: z.string().min(1),
    PAYPAL_CLIENT_SECRET: z.string().min(1),
    PAYPAL_ENV: z.enum(["sandbox", "live"]),
    PASSKEY_RP_ID: z.string().min(1).optional(),
    ANTHROPIC_API_KEY: z.string().min(1).optional(),
    TEE_A_URL: z.url().optional(),
    TEE_B_URL: z.url().optional(),
    KEELSON_TEE_TOKEN: z.string().min(32).optional(),
    ARBITRUM_SEPOLIA_RPC_URL: z.url().optional(),
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
  .refine((env) => env.NODE_ENV !== "production" || env.TEE_A_URL !== undefined, {
    message: "the TEE legs are required in production",
    path: ["TEE_A_URL"],
  })
  .refine((env) => env.PASSKEY_RP_ID === undefined || env.NODE_ENV === "test", {
    message: "PASSKEY_RP_ID may only be set in tests",
    path: ["PASSKEY_RP_ID"],
  });

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
