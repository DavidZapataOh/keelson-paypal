import type { APIRoute } from "astro";
import { docs, SITE } from "../lib/docs";
import { INSTRUCTIONS } from "./llms.txt";

export const GET: APIRoute = async () => {
  const pages = (await docs()).map(
    (d) => `# ${d.data.title}\n\nSource: ${SITE}/${d.id}.md\n\n${(d.body ?? "").trim()}`,
  );
  const text = `# Keelson\n\n${INSTRUCTIONS}\n\n${pages.join("\n\n---\n\n")}\n`;
  return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
};
