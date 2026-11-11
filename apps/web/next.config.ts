import type { NextConfig } from "next";

/** A static export: the app talks to the API from the browser, with the API's session cookie. */
const config: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ["@keelson/ui"],
  reactStrictMode: true,
  poweredByHeader: false,
  // Absolute asset URLs let the API serve the embedded approval's markup from its own origin.
  ...(process.env.NEXT_PUBLIC_ASSET_ORIGIN
    ? { assetPrefix: process.env.NEXT_PUBLIC_ASSET_ORIGIN }
    : {}),
};

export default config;
