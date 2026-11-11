import markdoc from "@astrojs/markdoc";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://docs.keelson.finance",
  trailingSlash: "always",
  devToolbar: { enabled: false },
  integrations: [markdoc()],
  // Scripts ship as files, so the CSP allows them by origin and only the theme script needs a hash.
  vite: { build: { assetsInlineLimit: 0 } },
});
