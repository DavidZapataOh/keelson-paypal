import { z } from "zod";

const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z.string().min(32),
    BETTER_AUTH_URL: z.url(),
    PORT: z.coerce.number().int().positive().default(10000),
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  })
  .refine((env) => env.NODE_ENV !== "production" || env.BETTER_AUTH_URL.startsWith("https://"), {
    message: "BETTER_AUTH_URL must use https in production",
    path: ["BETTER_AUTH_URL"],
  });

export type Env = z.infer<typeof schema>;

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return schema.parse(source);
}
