import { type Json, jcs } from "@keelson/core";
import { leafHash } from "@keelson/log";
import { decodeSign1, encodeSign1, protectedHeader } from "@keelson/scitt";
import type { z } from "zod";
import { fromBase64, toBase64, toBase64url } from "./b64.ts";
import {
  ALIBI_MEDIA_TYPE,
  ALIBI_MEDIA_TYPE_V2,
  type AlibiBundle,
  type AlibiBundleV2,
  type AlibiReceipt,
  type AlibiReceiptV2,
  type AnyAlibi,
  alibiSchema,
  alibiSchemaV2,
  MAX_ALIBI_BYTES,
  RECEIPT_MEDIA_TYPE_V2,
  receiptSchema,
  receiptSchemaV2,
} from "./schema.ts";

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
  if (bytes.length > MAX_ALIBI_BYTES) throw new AlibiFormatError("json", "larger than 256 KiB");
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
export function isBundle(b: AnyAlibi): b is AlibiBundle | AlibiBundleV2 {
  return "type" in b && (b.type === ALIBI_MEDIA_TYPE || b.type === ALIBI_MEDIA_TYPE_V2);
}

/** 1 for a JCS-leaf Alibi, 2 for a SCITT transparent statement. */
export function versionOf(a: AnyAlibi): 1 | 2 {
  return "statement" in a ? 2 : 1;
}

const schemaOfType = (type: unknown) =>
  type === ALIBI_MEDIA_TYPE_V2
    ? alibiSchemaV2
    : type === RECEIPT_MEDIA_TYPE_V2
      ? receiptSchemaV2
      : type === ALIBI_MEDIA_TYPE
        ? alibiSchema
        : receiptSchema;

/** Decodes any Alibi or receipt of either version, by its `type`. */
export function decodeAny(bytes: Uint8Array): AnyAlibi {
  let type: unknown;
  try {
    type = (JSON.parse(new TextDecoder().decode(bytes)) as { type?: unknown }).type;
  } catch {
    throw new AlibiFormatError("json", "not UTF-8 JSON");
  }
  return decode(schemaOfType(type) as z.ZodType<AnyAlibi>, bytes);
}

export function encodeAny(a: AnyAlibi): Uint8Array {
  const type = (a as { type?: unknown }).type;
  return encoder.encode(jcs(validate(schemaOfType(type) as z.ZodType<AnyAlibi>, a) as Json));
}

/** The transparent statement a v2 Alibi carries. */
export function statementOf(a: AlibiBundleV2 | AlibiReceiptV2): Uint8Array {
  return fromBase64(a.statement);
}

/** The statement as the log registered it: the transparent statement without its unprotected header. */
export function registeredOf(a: AlibiBundleV2 | AlibiReceiptV2): Uint8Array {
  const s = decodeSign1(statementOf(a));
  return encodeSign1({ ...s, unprotected: new Map() });
}

/** The RFC 6962 hash of the Alibi's log leaf. */
export function leafHashOf(b: AnyAlibi): Uint8Array {
  if ("statement" in b) return leafHash(registeredOf(b));
  const hash = leafHash(fromBase64(b.leaf));
  if (!isBundle(b) && toBase64url(hash) !== b.leaf_hash) {
    throw new AlibiFormatError("schema", "leaf_hash is not the hash of leaf", "/leaf_hash");
  }
  return hash;
}

/** The public receipt of a bundle: only what the log publishes. */
export function receiptOf(b: AlibiBundle): AlibiReceipt;
export function receiptOf(b: AlibiBundleV2): AlibiReceiptV2;
export function receiptOf(b: AlibiBundle | AlibiBundleV2): AlibiReceipt | AlibiReceiptV2 {
  if ("statement" in b) {
    return {
      type: RECEIPT_MEDIA_TYPE_V2,
      alibi_id: b.alibi_id,
      statement: b.statement,
      tlog_proof: b.tlog_proof,
      ...(b.anchor ? { anchor: b.anchor } : {}),
    };
  }
  return {
    alibi_id: b.alibi_id,
    leaf: b.leaf,
    leaf_hash: toBase64url(leafHashOf(b)),
    tlog_proof: b.tlog_proof,
    ...(b.anchor ? { anchor: b.anchor } : {}),
    timestamps: b.timestamps,
  };
}

/** A bare `.cose` statement file as a v2 receipt without a log proof, or null if it is not one. */
export function decodeStatementFile(bytes: Uint8Array): AlibiReceiptV2 | null {
  let alibiId: unknown;
  try {
    const cwt = protectedHeader(decodeSign1(bytes)).get(15);
    alibiId = cwt instanceof Map ? cwt.get(2) : undefined;
  } catch {
    return null;
  }
  if (typeof alibiId !== "string") return null;
  return validate(receiptSchemaV2, {
    type: RECEIPT_MEDIA_TYPE_V2,
    alibi_id: alibiId,
    statement: toBase64(bytes),
  });
}
