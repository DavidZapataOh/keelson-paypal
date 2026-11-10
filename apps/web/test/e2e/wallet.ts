import type { BrowserContext } from "playwright";
import { type Hex, hexToString, type PrivateKeyAccount, type TypedDataDefinition } from "viem";

/**
 * Gives every page of `context` an EIP-1193 `window.ethereum` whose account is `account`: it
 * signs for real in Node. `call` answers `eth_call` (a real RPC in live runs).
 */
export async function installWallet(
  context: BrowserContext,
  account: PrivateKeyAccount,
  call: (tx: { to: Hex; data: Hex }) => Promise<Hex>,
  chainId = 421614,
): Promise<{ signed: { method: string; params: unknown[] }[] }> {
  const signed: { method: string; params: unknown[] }[] = [];
  await context.exposeFunction("__wallet", async (method: string, params: unknown[]) => {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return `0x${chainId.toString(16)}`;
      case "wallet_switchEthereumChain":
        return null;
      case "personal_sign": {
        signed.push({ method, params });
        const message = params[0] as string;
        return account.signMessage({
          message: message.startsWith("0x") ? hexToString(message as Hex) : message,
        });
      }
      case "eth_signTypedData_v4": {
        signed.push({ method, params });
        // As a wallet does: the domain is hashed with the `EIP712Domain` fields the request lists.
        return account.signTypedData(JSON.parse(params[1] as string) as TypedDataDefinition);
      }
      case "eth_call":
        return call(params[0] as { to: Hex; data: Hex });
      default:
        throw new Error(`unsupported ${method}`);
    }
  });
  await context.addInitScript(() => {
    const w = window as unknown as {
      ethereum: unknown;
      __wallet: (m: string, p: unknown[]) => Promise<unknown>;
    };
    w.ethereum = {
      request: ({ method, params }: { method: string; params?: unknown[] }) =>
        w.__wallet(method, params ?? []),
    };
  });
  return { signed };
}
