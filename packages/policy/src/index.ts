/**
 * The Keelson policy evaluator for the browser: the same Cedar policies, entity and
 * `keelson.eval/1` trace as the Rust engine, on `@cedar-policy/cedar-wasm`.
 *
 * The package imports Cedar's bundler build, which loads its `.wasm` as an ES module: browsers
 * need a bundler with WebAssembly support (Vite with `vite-plugin-wasm`, webpack with
 * `experiments.asyncWebAssembly`), and Node loads it natively.
 *
 * Traces from the TEE are authoritative. In the browser, the evaluator verifies one by
 * evaluating the same input with the `engine` meta the trace records and comparing the whole
 * result with it byte for byte, which covers `decision` and `fired` at the least; a trace it
 * emits is never a substitute for the TEE's.
 *
 * @packageDocumentation
 */

export { cartContext } from "./cart.ts";
export { agentUid, EntityError, mandateAgent, mandateEntity } from "./entity.ts";
export {
  type Context,
  type EngineMeta,
  type EvalInput,
  evaluate,
  evaluateContext,
  type Variant,
} from "./evaluate.ts";
export {
  compileExtras,
  type Extra,
  ExtrasError,
  type InvalidExtra,
  MAX_EXTRAS,
  parseExtras,
} from "./extras.ts";
export { POLICY_SET_HASH, POLICY_SET_SRC, SCHEMA_HASH, SCHEMA_SRC } from "./policy.ts";
export { type Engine, type FieldTrace, TRACE_VERSION, type Trace, traceJcs } from "./trace.ts";
