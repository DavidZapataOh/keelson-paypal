export const repoUrl = "https://github.com/DavidZapataOh/keelson-paypal";

export const appUrl: string = import.meta.env.PUBLIC_APP_URL ?? "https://app.keelson.finance";

export const verifyUrl = "https://verify.keelson.finance";

export const storeUrl = "https://store.keelson.finance";

export const apiReferenceUrl = `${repoUrl}/blob/main/openapi/keelson.yaml`;

export const monitorUrl = "https://keelson-monitor-production.up.railway.app";

/**
 * The Alibi the landing lets visitors tamper with: a PayPal sandbox purchase, entry 757 of
 * log.keelson.finance/alibi/2026-1, anchored on Arbitrum Sepolia at size 758.
 */
export const demoAlibi = {
  id: "01M71DB3MZAX38NGP3NM8F48T6",
  link: "01M71DB3MZAX38NGP3NM8F48T6#PEcnLYqWw5d91wlYjOVd5sYkUkqz2uQJ-k6TBE0t5h0.758.421614",
  block: "327708649",
} as const;
