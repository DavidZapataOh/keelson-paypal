import { type Json, jcs } from "@keelson/core";
import { pointer } from "../../codec.ts";
import { alibiSchema, receiptSchema } from "../../schema.ts";
import { type CheckDef, expect, pass } from "../check.ts";
import { isBundle } from "./util.ts";

/** The input is a well-formed bundle or receipt with one RFC 8785 form. */
export const format: CheckDef = {
  id: "bundle.format",
  step: 0,
  reads: [""],
  run(input) {
    const out = (isBundle(input) ? alibiSchema : receiptSchema).safeParse(input);
    const issue = out.success ? undefined : out.error.issues[0];
    expect(!issue, issue?.message ?? "", [pointer(issue?.path ?? [])]);
    jcs(input as unknown as Json);
    return pass();
  },
};
