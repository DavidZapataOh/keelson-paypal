import markdoc from "@astrojs/markdoc";
import { defineConfig } from "astro/config";

export default defineConfig({
  site: "https://docs.keelson.finance",
  trailingSlash: "always",
  devToolbar: { enabled: false },
  integrations: [markdoc()],
});
