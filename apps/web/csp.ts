/**
 * The Content-Security-Policy the static site serves (render.yaml), kept here so tests serve the
 * same one. A static export has no per-request nonce, so its inline bootstrap scripts need
 * `'unsafe-inline'`; every script still comes from this origin or PayPal's. Rive and the mandate
 * commitment run WebAssembly; the commitment's wasm is inlined as a `data:` URL and fetched.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://*.paypal.com https://*.paypalobjects.com",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self' data: https://api.keelson.finance https://*.paypal.com https://*.paypalobjects.com",
  "img-src 'self' data: blob: https://*.paypal.com https://*.paypalobjects.com",
  "frame-src https://*.paypal.com",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
