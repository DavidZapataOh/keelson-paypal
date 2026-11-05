export type PayPalEnv = "sandbox" | "production";

export interface PayPalConfig {
  env: PayPalEnv;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
}

const BASE_URLS: Record<PayPalEnv, string> = {
  sandbox: "https://api-m.sandbox.paypal.com",
  production: "https://api-m.paypal.com",
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

export function paypalConfig(env: NodeJS.ProcessEnv = process.env): PayPalConfig {
  const mode = env.PAYPAL_ENV;
  if (mode !== "sandbox" && mode !== "production") {
    throw new Error('PAYPAL_ENV must be "sandbox" or "production"');
  }
  return {
    env: mode,
    baseUrl: BASE_URLS[mode],
    clientId: required(env, "PAYPAL_CLIENT_ID"),
    clientSecret: required(env, "PAYPAL_CLIENT_SECRET"),
  };
}
