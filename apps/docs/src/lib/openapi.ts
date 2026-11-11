import openapi from "../../public/openapi.json";

export const API = "https://api.keelson.finance";

/** Operations anyone can call without credentials; the API opens exactly these to the docs origin. */
export const PUBLIC_OPERATIONS = [
  "GET /status",
  "GET /v1/live-purchases",
  "GET /v1/log/bonds",
  "POST /v1/alibis/verify",
  "GET /v1/alibis/{id}/receipt",
] as const;

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof METHODS)[number];

export interface Schema {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  items?: Schema;
  properties?: Record<string, Schema>;
  required?: string[];
  anyOf?: Schema[];
  oneOf?: Schema[];
  allOf?: Schema[];
  example?: unknown;
  examples?: unknown[];
  $ref?: string;
}

export interface Param {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema?: Schema;
}

export interface Response {
  status: string;
  description: string;
  mediaType?: string;
  schema?: Schema;
}

export interface Operation {
  slug: string;
  method: Method;
  path: string;
  tag: string;
  summary: string;
  description?: string;
  params: Param[];
  body?: { mediaType: string; required: boolean; schema?: Schema };
  responses: Response[];
  tryIt: boolean;
}

interface RawOperation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  description?: string;
  parameters?: (Param & { $ref?: string })[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Schema }> };
  responses?: Record<
    string,
    { description?: string; content?: Record<string, { schema?: Schema }> }
  >;
}

const document = openapi as unknown as {
  paths: Record<string, Partial<Record<Method, RawOperation>>>;
  components?: { schemas?: Record<string, Schema>; parameters?: Record<string, Param> };
};

function deref<T extends { $ref?: string }>(value: T, seen = new Set<string>()): T {
  if (!value?.$ref) return value;
  if (seen.has(value.$ref)) return {} as T;
  const [, section, name] = value.$ref.match(/^#\/components\/(\w+)\/(.+)$/) ?? [];
  const target = (document.components as Record<string, Record<string, T>> | undefined)?.[
    section ?? ""
  ]?.[name ?? ""];
  return target ? deref(target, new Set([...seen, value.$ref])) : value;
}

/** A schema with every `$ref` replaced by its target, to `depth` levels. */
export function resolve(schema: Schema | undefined, depth = 4): Schema | undefined {
  if (!schema) return undefined;
  const s = deref(schema);
  if (depth === 0) return s;
  return {
    ...s,
    items: resolve(s.items, depth - 1),
    properties: s.properties
      ? Object.fromEntries(
          Object.entries(s.properties).map(([k, v]) => [k, resolve(v, depth - 1) ?? {}]),
        )
      : undefined,
    anyOf: s.anyOf?.map((v) => resolve(v, depth - 1) ?? {}),
    oneOf: s.oneOf?.map((v) => resolve(v, depth - 1) ?? {}),
    allOf: s.allOf?.map((v) => resolve(v, depth - 1) ?? {}),
  };
}

const first = <T>(content: Record<string, T> | undefined) => {
  const [mediaType, value] = Object.entries(content ?? {})[0] ?? [];
  return mediaType ? { mediaType, value: value as T } : undefined;
};

export const slugOf = (method: string, path: string, operationId?: string) =>
  operationId ??
  `${method}-${path}`
    .replace(/[{}]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/-+$/, "")
    .toLowerCase();

let cache: Operation[] | undefined;

/** Every operation of the API's OpenAPI document, in document order. */
export function operations(): Operation[] {
  cache ??= Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((method) => {
      const op = item[method] as RawOperation;
      const params: Param[] = (op.parameters ?? []).map((p) => {
        const r = deref(p);
        return { ...r, required: r.required ?? r.in === "path", schema: resolve(r.schema) };
      });
      const body = first(op.requestBody?.content);
      // Every POST under /v1 must carry an Idempotency-Key; the API rejects it with a problem otherwise.
      if (method === "post" && path.startsWith("/v1/")) {
        params.push({
          name: "Idempotency-Key",
          in: "header",
          required: true,
          description: "1 to 255 characters. A retry with the same key returns the first answer.",
          schema: { type: "string" },
        });
      }
      if (body) {
        params.unshift({
          name: "Content-Type",
          in: "header",
          required: true,
          schema: { type: "string", enum: [body.mediaType] },
        });
      }
      return {
        slug: slugOf(method, path, op.operationId),
        method,
        path,
        tag: op.tags?.[0] ?? "other",
        summary: op.summary ?? `${method.toUpperCase()} ${path}`,
        description: op.description,
        params,
        body: body
          ? {
              mediaType: body.mediaType,
              required: op.requestBody?.required ?? false,
              schema: resolve(body.value.schema),
            }
          : undefined,
        responses: Object.entries(op.responses ?? {}).map(([status, r]) => {
          const content = first(r.content);
          return {
            status,
            description: r.description ?? "",
            mediaType: content?.mediaType,
            schema: resolve(content?.value.schema),
          };
        }),
        tryIt: (PUBLIC_OPERATIONS as readonly string[]).includes(`${method.toUpperCase()} ${path}`),
      } satisfies Operation;
    }),
  );
  return cache;
}

/** A value shaped by the schema: its own example first, then one built from types and property names. */
export function example(schema: Schema | undefined, depth = 4): unknown {
  if (!schema) return undefined;
  if (schema.example !== undefined) return schema.example;
  if (schema.examples?.length) return schema.examples[0];
  if (schema.enum?.length) return schema.enum[0];
  const variant = schema.oneOf?.[0] ?? schema.anyOf?.[0];
  if (variant) return example(variant, depth);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => example(s, depth)));
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  if (type === "object" || schema.properties) {
    if (depth === 0) return {};
    return Object.fromEntries(
      Object.entries(schema.properties ?? {}).map(([k, v]) => [k, example(v, depth - 1)]),
    );
  }
  if (type === "array") return depth === 0 ? [] : [example(schema.items, depth - 1)];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return true;
  if (schema.format === "date-time") return "2026-11-11T00:00:00.000Z";
  return "string";
}

const url = (op: Operation) => `${API}${op.path}`;

/** A request sample for the operation, in cURL or TypeScript. */
export function sample(op: Operation, lang: "curl" | "ts"): string {
  const headers = op.params.filter((p) => p.in === "header");
  const value = (p: Param) =>
    p.name === "Idempotency-Key"
      ? "$(uuidgen)"
      : p.name === "Content-Type"
        ? String(p.schema?.enum?.[0])
        : `<${p.name}>`;
  if (lang === "curl") {
    const lines = [`curl -X ${op.method.toUpperCase()} ${url(op)}`];
    for (const h of headers) {
      const v = value(h);
      lines.push(
        v.startsWith("$(")
          ? `  -H "${h.name.toLowerCase()}: ${v}"`
          : `  -H '${h.name.toLowerCase()}: ${v}'`,
      );
    }
    if (op.body)
      lines.push(
        op.body.schema?.format === "binary"
          ? "  --data-binary @file"
          : `  --data '${JSON.stringify(example(op.body.schema))}'`,
      );
    return lines.join(" \\\n");
  }
  const tsValue = (p: Param) =>
    p.name === "Idempotency-Key" ? "crypto.randomUUID()" : JSON.stringify(value(p));
  const init = [`  method: "${op.method.toUpperCase()}",`];
  if (headers.length)
    init.push(
      `  headers: {\n${headers.map((h) => `    "${h.name.toLowerCase()}": ${tsValue(h)},`).join("\n")}\n  },`,
    );
  if (op.body)
    init.push(
      op.body.schema?.format === "binary"
        ? "  body: file,"
        : `  body: JSON.stringify(${JSON.stringify(example(op.body.schema), null, 2).replace(/\n/g, "\n  ")}),`,
    );
  return `const res = await fetch("${url(op)}", {\n${init.join("\n")}\n});\nconst data = await res.json();`;
}

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The OpenAPI document's descriptions use backticks for code; nothing else is interpreted. */
export const inline = (text: string) => escapeHtml(text).replace(/`([^`]+)`/g, "<code>$1</code>");

const TAG_NAMES: Record<string, string> = { paypal: "PayPal", tee: "TEE", "red team": "Red team" };

export const tagName = (tag: string) =>
  TAG_NAMES[tag] ?? tag.charAt(0).toUpperCase() + tag.slice(1);
