import { type Json, jcs } from "@keelson/core";
import { pointer } from "../../codec.ts";
import { alibiSchema, alibiSchemaV2, receiptSchema, receiptSchemaV2 } from "../../schema.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle } from "./util.ts";

/** The input is a well-formed bundle or receipt with one RFC 8785 form. */
export const format: CheckDef = {
  id: "bundle.format",
  step: 0,
  reads: [""],
  run(input, { view }) {
    const original = view ? view.input : input;
    const schema = view
      ? "attestation" in view.input
        ? alibiSchemaV2
        : receiptSchemaV2
      : isBundle(input)
        ? alibiSchema
        : receiptSchema;
    const out = schema.safeParse(original);
    const issue = out.success ? undefined : out.error.issues[0];
    expect(!issue, issue?.message ?? "", [pointer(issue?.path ?? [])]);
    jcs(original as unknown as Json);
    return pass();
  },
};
