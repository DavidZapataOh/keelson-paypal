/** A time-stamping authority Keelson asks for RFC 3161 tokens. */
export type TsaId = "digicert" | "sigstore" | "freetsa" | "sectigo";

/** Public endpoints, over HTTPS where the TSA serves it (DigiCert does not). Sectigo asks automated clients to wait at least 15 s between requests. */
export const TSAS: Record<TsaId, { url: string; minIntervalMs: number }> = {
  digicert: { url: "http://timestamp.digicert.com", minIntervalMs: 0 },
  sigstore: { url: "https://timestamp.sigstore.dev/api/v1/timestamp", minIntervalMs: 0 },
  freetsa: { url: "https://freetsa.org/tsr", minIntervalMs: 0 },
  sectigo: { url: "https://timestamp.sectigo.com/qualified", minIntervalMs: 15_000 },
};
