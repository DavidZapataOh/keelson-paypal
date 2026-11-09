import type { Hex, LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** The account that signs an operator's `Coverage`, or `undefined` when Keelson holds no key for it. */
export type OperatorSigners = (agentId: bigint) => LocalAccount | undefined;

/** Signs for the one operator whose key this deployment holds. */
export function operatorSigners(agentId: bigint, key: Hex): OperatorSigners {
  const account = privateKeyToAccount(key);
  return (id) => (id === agentId ? account : undefined);
}
