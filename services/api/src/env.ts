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
  .refine((env) => env.PASSKEY_RP_ID === undefined || env.NODE_ENV === "test", {
    message: "PASSKEY_RP_ID may only be set in tests",
    path: ["PASSKEY_RP_ID"],
  });

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
