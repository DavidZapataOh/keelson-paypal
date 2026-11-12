import type { components, operations } from "./schema.js";

type S = components["schemas"];

/** The JSON body an operation answers with on 200 (or 201, 202). */
export type ResponseOf<Op extends keyof operations> = operations[Op]["responses"] extends infer R
  ? R extends { 200: { content: { "application/json": infer B } } }
    ? B
    : R extends { 201: { content: { "application/json": infer B } } }
      ? B
      : R extends { 202: { content: { "application/json": infer B } } }
        ? B
        : never
  : never;

export type AgentRun = S["AgentRun"];
export type AlibiReceipt = S["AlibiReceipt"];
export type AlibiReport = S["AlibiReport"];
export type Cart = S["Cart"];
export type CartCheck = S["CartCheck"];
export type ConnectionLimits = S["ConnectionLimits"];
export type ConnectionRequestState = S["ConnectionRequestState"];
export type Countersigned = S["Countersigned"];
export type DeviceAuthorization = S["DeviceAuthorization"];
export type DisputeStatus = S["DisputeStatus"];
export type EvidenceManifest = S["EvidenceManifest"];
export type OnceApproval = S["OnceApproval"];
export type Operator = S["Operator"];
export type OperatorMandate = S["OperatorMandate"];
export type Problem = S["Problem"];
export type Purchase = S["Purchase"];
export type TeeLeg = S["TeeLeg"];
export type Timestamp = S["Timestamp"];
export type TrustGrade = S["TrustGrade"];
export type Status = ResponseOf<"getStatus">;
