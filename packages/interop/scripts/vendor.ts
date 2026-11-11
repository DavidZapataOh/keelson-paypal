/**
 * Fetches the upstream schemas and test vectors the exports are checked against, each at a pinned
 * commit, into `vendor/`, and records every file's SHA-256 in `vendor/PINS.json`.
 *
 * Run with `GITHUB_TOKEN` set to avoid the GitHub API's anonymous rate limit.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PINNED_COMMITS = {
  ap2: "e1ea56db72a6385bce3e5c1112b3a56ce60acb43",
  goodmeta: "41dff653dea4a3025ca6e1d5339121cd8a1623a5",
  ucp: "87dd4b1fcff9105d68173120897237fa784c74ef",
  acp: "7fdd78df677a94dce04c770644b0fbbb1401272b",
  webBotAuth: "01c0d10a5f00d4e77cc5677576a7a2b6e4954d50",
  negativeVectors: "eb51afe2c854dfb99d8c3fb194e86de99b3c9796",
} as const;

interface Source {
  key: keyof typeof PINNED_COMMITS;
  repo: string;
  dir: string;
  /** Upstream paths to take: a prefix ending in `/`, or a file. */
  paths: string[];
  /** The upstream prefix stripped from each path under `vendor/<dir>/`. */
  strip: string;
}

const SOURCES: Source[] = [
  {
    key: "ap2",
    repo: "google-agentic-commerce/AP2",
    dir: "ap2",
    paths: ["code/sdk/schemas/", "LICENSE"],
    strip: "code/sdk/schemas/",
  },
  {
    key: "goodmeta",
    repo: "goodmeta/ap2-conformance",
    dir: "goodmeta",
    paths: ["vectors/", "LICENSE", "NOTICE", "VECTORS.md"],
    strip: "",
  },
  {
    key: "ucp",
    repo: "Universal-Commerce-Protocol/ucp",
    dir: "ucp",
    paths: ["source/schemas/", "LICENSE"],
    strip: "source/schemas/",
  },
  {
    key: "acp",
    repo: "agentic-commerce-protocol/agentic-commerce-protocol",
    dir: "acp",
    paths: ["spec/2026-04-17/json-schema/", "LICENSE"],
    strip: "spec/2026-04-17/json-schema/",
  },
  {
    key: "webBotAuth",
    repo: "cloudflare/web-bot-auth",
    dir: "web-bot-auth",
    paths: ["packages/web-bot-auth/test/test_data/", "LICENSE"],
    strip: "packages/web-bot-auth/test/test_data/",
  },
  {
    key: "negativeVectors",
    repo: "ParallaxGrain/webbotauth-negative-vectors",
    dir: "webbotauth-negative-vectors",
    paths: ["vectors/", "LICENSE"],
    strip: "",
  },
];

const headers: Record<string, string> = process.env.GITHUB_TOKEN
  ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
  : {};

async function tree(repo: string, commit: string): Promise<string[]> {
  const res = await fetch(`https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`, {
    headers,
  });
  if (!res.ok) throw new Error(`${repo}@${commit}: tree ${res.status}`);
  const body = (await res.json()) as { tree: { path: string; type: string }[]; truncated: boolean };
  if (body.truncated) throw new Error(`${repo}@${commit}: tree truncated`);
  return body.tree.filter((t) => t.type === "blob").map((t) => t.path);
}

async function main() {
  const vendor = new URL("../vendor/", import.meta.url);
  const files: { path: string; source: string; commit: string; sha256: string }[] = [];
  for (const s of SOURCES) {
    const commit = PINNED_COMMITS[s.key];
    const wanted = (await tree(s.repo, commit)).filter((p) =>
      s.paths.some((w) => (w.endsWith("/") ? p.startsWith(w) : p === w)),
    );
    for (const p of wanted) {
      const res = await fetch(`https://raw.githubusercontent.com/${s.repo}/${commit}/${p}`);
      if (!res.ok) throw new Error(`${s.repo}@${commit}/${p}: ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const path = `${s.dir}/${p.startsWith(s.strip) ? p.slice(s.strip.length) : p}`;
      const out = new URL(path, vendor);
      mkdirSync(dirname(out.pathname), { recursive: true });
      writeFileSync(out, bytes);
      files.push({
        path,
        source: `https://github.com/${s.repo}/blob/${commit}/${p}`,
        commit,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  writeFileSync(new URL("PINS.json", vendor), `${JSON.stringify({ files }, null, 2)}\n`);
  console.log(`vendored ${files.length} files`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
