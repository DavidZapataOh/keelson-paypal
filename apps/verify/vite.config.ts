import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The policy the deployed site serves (render.yaml); previews serve it too, so tests run under it. */
export const CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' https://api.keelson.finance https://log.keelson.finance https:; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors https://keelson.finance";

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
