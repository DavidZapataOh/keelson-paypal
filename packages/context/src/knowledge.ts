import { readdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";

export type Language = "typescript" | "python";

export interface Endpoint {
  operationId: string;
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  /** The OAuth scopes, or `session`, that admit the call; empty for a public one. */
  security: string[];
  /** How the SDK of the language calls it. */
  usage: string;
}

export interface Model {
  name: string;
  /** The schema as the OpenAPI document gives it (JSON Schema 2020-12). */
  schema: Record<string, unknown>;
  /** The type the SDK of the language generates for it. */
  type: string;
}

export interface Section {
  language: Language;
  source: string;
  heading: string;
  text: string;
}

const contextDir = new URL("../context/", import.meta.url);

const words = (text: string) =>
  text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1);

const STOP = new Set(["how", "do", "the", "an", "to", "of", "in", "with", "and", "for", "my", "is"]);

/** How many of the query's words appear in the text, the rarer weighing the same: a simple, deterministic rank. */
function score(query: string[], text: string): number {
  const have = new Set(words(text));
  return query.filter((w) => !STOP.has(w) && have.has(w)).length;
}

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

function usage(e: Omit<Endpoint, "usage">, op: Operation, language: Language): string {
  const params = (op.parameters ?? []).filter((p) => p.in === "path" || p.in === "query");
  const hasBody = op.requestBody !== undefined;
  if (language === "typescript") {
    const path = params.filter((p) => p.in === "path").map((p) => `${p.name}: "…"`);
    const query = params.filter((p) => p.in === "query").map((p) => `${p.name}: "…"`);
    const options = [
      path.length ? `path: { ${path.join(", ")} }` : "",
      query.length ? `query: { ${query.join(", ")} }` : "",
      hasBody ? "body: { … }" : "",
    ].filter(Boolean);
    return `import { Keelson, unwrap } from "@keelson/sdk";\n\nconst answer = await unwrap(keelson.${e.operationId}(${options.length ? `{ ${options.join(", ")} }` : ""}));`;
  }
  const module = snake(e.operationId);
  const args = [
    ...params.map((p) => `${snake(p.name)}="…"`),
    "client=client",
    ...(hasBody ? ["body=…"] : []),
  ];
  return `from keelson import unwrap\nfrom keelson.generated.api.${snake(e.tag).replace(/\s+/g, "_")} import ${module}\n\nanswer = unwrap(${module}.sync_detailed(${args.join(", ")}))`;
}

interface Operation {
  operationId: string;
  tags?: string[];
  summary?: string;
  description?: string;
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string }[];
  requestBody?: unknown;
}

interface Document {
  paths: Record<string, Record<string, Operation>>;
  components: { schemas: Record<string, Record<string, unknown>> };
}

/** Markdown split at its `##` and `###` headings. */
function sections(language: Language, source: string, markdown: string): Section[] {
  const out: Section[] = [];
  let heading = source;
  let lines: string[] = [];
  const flush = () => {
    if (lines.join("").trim()) out.push({ language, source, heading, text: lines.join("\n").trim() });
  };
  for (const line of markdown.split("\n")) {
    const h = /^#{1,3} (.+)$/.exec(line);
    if (h) {
      flush();
      heading = h[1] as string;
      lines = [line];
    } else lines.push(line);
  }
  flush();
  return out;
}

/** What the plugin answers from: the OpenAPI document and the SDKs' READMEs and examples. */
export class Knowledge {
  readonly #doc: Document;
  readonly #sections: Section[];

  constructor(dir: URL = contextDir) {
    this.#doc = parse(readFileSync(new URL("keelson.yaml", dir), "utf8")) as Document;
    this.#sections = (["typescript", "python"] as const).flatMap((language) => {
      const base = new URL(`${language}/`, dir);
      const readme = sections(language, "README.md", readFileSync(new URL("README.md", base), "utf8"));
      const examples = readdirSync(new URL("examples/", base)).map((file) => ({
        language,
        source: `examples/${file}`,
        heading: file,
        text: readFileSync(new URL(`examples/${file}`, base), "utf8"),
      }));
      return [...readme, ...examples];
    });
  }

  endpoints(query: string, language: Language, limit = 5): Endpoint[] {
    const q = words(query);
    const ranked: { e: Endpoint; s: number }[] = [];
    for (const [path, ops] of Object.entries(this.#doc.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const base = {
          operationId: op.operationId,
          method: method.toUpperCase(),
          path,
          tag: op.tags?.[0] ?? "default",
          summary: op.summary ?? "",
          description: op.description ?? "",
          security: [
            ...new Set(
              (op.security ?? []).flatMap((r) =>
                Object.entries(r).flatMap(([scheme, scopes]) =>
                  scopes.length ? scopes : [scheme],
                ),
              ),
            ),
          ],
        };
        // The name, path and summary say what an operation is; its description only breaks ties.
        const s =
          4 * score(q, `${op.operationId} ${path} ${base.summary}`) +
          Math.min(1, score(q, base.description));
        if (s >= 4) ranked.push({ e: { ...base, usage: usage(base, op, language) }, s });
      }
    }
    return ranked
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((r) => r.e);
  }

  model(name: string, language: Language): Model[] {
    const want = name.toLowerCase();
    return Object.entries(this.#doc.components.schemas)
      .filter(([n]) => n.toLowerCase() === want || (want.length > 2 && n.toLowerCase().includes(want)))
      .sort(([a], [b]) => Number(b.toLowerCase() === want) - Number(a.toLowerCase() === want))
      .slice(0, 5)
      .map(([n, schema]) => ({
        name: n,
        schema,
        type:
          language === "typescript"
            ? `import type { ${n} } from "@keelson/sdk";`
            : `from keelson.generated.models import ${n}`,
      }));
  }

  ask(question: string, language: Language | undefined, limit = 3): Section[] {
    const q = words(question);
    return this.#sections
      .filter((s) => language === undefined || s.language === language)
      .map((s) => ({ s, n: 2 * score(q, s.heading) + score(q, s.text) }))
      .filter((r) => r.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, limit)
      .map((r) => r.s);
  }

  readme(language: Language): string {
    return this.#sections
      .filter((s) => s.language === language && s.source === "README.md")
      .map((s) => s.text)
      .join("\n\n");
  }
}
