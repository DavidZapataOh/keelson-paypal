import { type Json, jcs } from "@keelson/core";
import { leafHash } from "@keelson/log";
import type { z } from "zod";
import { fromBase64, toBase64url } from "./b64.ts";
import { type AlibiBundle, type AlibiReceipt, alibiSchema, receiptSchema } from "./schema.ts";

export type AlibiFormatCode = "json" | "schema" | "noncanonical" | "attachment";

export class AlibiFormatError extends Error {
  readonly code: AlibiFormatCode;
  /** RFC 6901 pointer of the failing value. */
  readonly pointer: string | undefined;

  constructor(code: AlibiFormatCode, message: string, pointer?: string) {
    super(message);
    this.name = "AlibiFormatError";
    this.code = code;
    this.pointer = pointer;
  }
}

const encoder = new TextEncoder();

/** RFC 6901 pointer of a path. */
export function pointer(path: readonly PropertyKey[]): string {
  return path.map((p) => `/${String(p).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

function validate<T>(schema: z.ZodType<T>, value: unknown): T {
  const out = schema.safeParse(value);
  if (out.success) return out.data;
  const issue = out.error.issues[0];
  throw new AlibiFormatError("schema", issue?.message ?? "invalid", pointer(issue?.path ?? []));
}

function decode<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new AlibiFormatError("json", "not UTF-8 JSON");
  }
  let canonical: Uint8Array;
  try {
    canonical = encoder.encode(jcs(value as Json));
  } catch (err) {
    throw new AlibiFormatError("noncanonical", (err as Error).message);
  }
  if (canonical.length !== bytes.length || canonical.some((b, i) => b !== bytes[i])) {
    throw new AlibiFormatError("noncanonical", "not the RFC 8785 form of its value");
  }
  return validate(schema, value);
}

/** The bundle's only byte form: UTF-8 of its RFC 8785 canonical JSON. */
export function encodeAlibi(b: AlibiBundle): Uint8Array {
  return encoder.encode(jcs(validate(alibiSchema, b) as Json));
}

/** Decodes a bundle, refusing anything that is not exactly the canonical form of a valid one. */
export function decodeAlibi(bytes: Uint8Array): AlibiBundle {
  return decode(alibiSchema, bytes);
}

export function encodeReceipt(r: AlibiReceipt): Uint8Array {
  return encoder.encode(jcs(validate(receiptSchema, r) as Json));
}

export function decodeReceipt(bytes: Uint8Array): AlibiReceipt {
  return decode(receiptSchema, bytes);
}

/** Whether the input is a full bundle rather than a public receipt. */
export function isBundle(b: AlibiBundle | AlibiReceipt): b is AlibiBundle {
  return "type" in b;
}

/** The RFC 6962 hash of the bundle's leaf. */
export function leafHashOf(b: AlibiBundle | AlibiReceipt): Uint8Array {
  const hash = leafHash(fromBase64(b.leaf));
  if (!isBundle(b) && toBase64url(hash) !== b.leaf_hash) {
    throw new AlibiFormatError("schema", "leaf_hash is not the hash of leaf", "/leaf_hash");
  }
  return hash;
}

/** The public receipt of a bundle: only what the log publishes. */
export function receiptOf(b: AlibiBundle): AlibiReceipt {
  return {
    alibi_id: b.alibi_id,
    leaf: b.leaf,
    leaf_hash: toBase64url(leafHashOf(b)),
    tlog_proof: b.tlog_proof,
    ...(b.anchor ? { anchor: b.anchor } : {}),
    timestamps: b.timestamps,
  };
}

