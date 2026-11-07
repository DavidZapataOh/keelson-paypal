/** Decodes one PEM certificate to DER. */
export function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----(BEGIN|END) CERTIFICATE-----|\s/g, "");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}
