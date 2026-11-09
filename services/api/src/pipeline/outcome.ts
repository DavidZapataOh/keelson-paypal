/** What a pipeline step answers: done, try again on the next drive, or fail the purchase. */
export type Outcome<T> =
  | { kind: "done"; value: T }
  | { kind: "retry"; reason: string }
  | { kind: "final"; reason: string };

export const done = <T>(value: T): Outcome<T> => ({ kind: "done", value });
export const retry = (reason: string): Outcome<never> => ({ kind: "retry", reason });
/** `reason` is `<step>:<code>`, as `purchases.failure_reason` stores it. */
export const final = (reason: string): Outcome<never> => ({ kind: "final", reason });
