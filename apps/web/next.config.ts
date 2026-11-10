import type { NextConfig } from "next";

/** A static export: the app talks to the API from the browser, with the API's session cookie. */
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@keelson/ui"],
  reactStrictMode: true,
  poweredByHeader: false,
};

export default config;
