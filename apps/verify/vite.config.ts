import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * The policy the deployed site serves (render.yaml); previews serve it too, so tests run under it.
 * bb.js inlines its wasm as a `data:` URL and fetches it, hence `data:` in `connect-src`.
 */
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data: https://api.keelson.finance https://log.keelson.finance https:; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://keelson.finance https://app.keelson.finance";

/**
 * Cedar's package.json lists only its snippets as side-effectful, so the bundler would drop the
 * entry module that instantiates its WebAssembly and leave every binding without an instance.
 */
function cedarEntry(): Plugin {
  const entry = /@cedar-policy[\\/]cedar-wasm[\\/]esm[\\/]cedar_wasm\.js$/;
  return {
    name: "keelson:cedar-entry",
    transform(code, id) {
      return entry.test(id) ? { code, moduleSideEffects: true } : undefined;
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), cedarEntry()],
  build: { target: "esnext" },
  preview: {
    port: 4173,
    strictPort: true,
    headers: {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
});
