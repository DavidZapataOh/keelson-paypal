import type { OpenAPIHono } from "@hono/zod-openapi";
import { problem } from "../problem.ts";
import { PROBLEM_TYPES, type ProblemSlug } from "../problem-types.ts";

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] ?? ch,
  );

function page(slug: ProblemSlug): string {
  const { title, explain, fix } = PROBLEM_TYPES[slug];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Keelson API</title><style>body{margin:0;background:#f2f0ea;color:#17181b;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}main{max-width:620px;margin:0 auto;padding:48px 20px}p.k{margin:0;font:600 12px/1 ui-monospace,Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:#6b6a66}h1{margin:18px 0 6px;font-size:28px;line-height:1.15}code{font-family:ui-monospace,Menlo,monospace;font-size:14px;background:#e7e4db;padding:2px 6px;border-radius:6px}h2{margin:28px 0 4px;font-size:15px}a{color:#17181b}@media(prefers-color-scheme:dark){body{background:#17181b;color:#f2f0ea}code{background:#2a2b2f}a{color:#f2f0ea}p.k{color:#a3a29d}}</style></head><body><main><p class="k">Keelson API · problem type</p><h1>${escapeHtml(title)}</h1><p><code>type: https://api.keelson.finance/problems/${slug}</code></p><h2>What happened</h2><p>${escapeHtml(explain)}</p><h2>What to do</h2><p>${escapeHtml(fix)}</p><p><a href="https://docs.keelson.finance/reference/api/">API reference</a> · <a href="/openapi.json">OpenAPI document</a></p></main></body></html>`;
}

/** `GET /problems/{slug}`: the page each RFC 9457 `type` the API returns resolves to. */
export function registerProblems(app: OpenAPIHono): void {
  app.get("/problems/:slug", (c) => {
    const slug = c.req.param("slug");
    if (!Object.hasOwn(PROBLEM_TYPES, slug)) return problem(c, 404, "not-found", "Not found");
    return c.html(page(slug as ProblemSlug), 200, { "cache-control": "public, max-age=86400" });
  });
}
