import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Keelson",
    short_name: "Keelson",
    description: "Sign what your agent may buy. Every purchase is checked before it pays.",
    id: "/",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f2f0ea",
    theme_color: "#f2f0ea",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
