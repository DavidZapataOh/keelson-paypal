import type {
  McpUiHostContext,
  McpUiHostContextChangedNotification,
  McpUiInitializedNotification,
  McpUiInitializeRequest,
  McpUiInitializeResult,
  McpUiOpenLinkRequest,
  McpUiSizeChangedNotification,
  McpUiToolResultNotification,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolRequest, CallToolResult } from "@modelcontextprotocol/server";

// The View side of MCP Apps (SEP-1865): JSON-RPC 2.0 over postMessage with the host, as the
// specification's own example does. The SDK's `App` class carries an MCP client and Zod, which
// would be most of this View's bytes.

type Methods = {
  [K in
    | McpUiInitializeRequest
    | McpUiOpenLinkRequest
    | CallToolRequest as K["method"]]: K["params"];
};
type Results = {
  "ui/initialize": McpUiInitializeResult;
  "ui/open-link": Record<string, never>;
  "tools/call": CallToolResult;
};
type Notification =
  | McpUiInitializedNotification
  | McpUiSizeChangedNotification
  | McpUiToolResultNotification
  | McpUiHostContextChangedNotification;

const PROTOCOL_VERSION: McpUiInitializeRequest["params"]["protocolVersion"] = "2026-01-26";

export interface Host {
  context: McpUiHostContext;
  request<M extends keyof Methods>(method: M, params: Methods[M]): Promise<Results[M]>;
}

/** Connects to the host and reports tool results and context changes until the page goes away. */
export async function connect(
  appInfo: { name: string; version: string },
  on: {
    toolResult(result: McpUiToolResultNotification["params"]): void;
    context(context: McpUiHostContext): void;
  },
): Promise<Host> {
  let next = 0;
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  const post = (message: object) => window.parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
  const notify = (n: Notification) => post(n);

  const host: Host = {
    context: {},
    request(method, params) {
      const id = ++next;
      post({ id, method, params });
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject })) as never;
    },
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const m = event.data as {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message: string };
    };
    if (m?.id !== undefined && !m.method) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new Error(m.error.message));
      else p?.resolve(m.result);
    } else if (m?.method === "ui/notifications/tool-result") {
      on.toolResult(m.params as McpUiToolResultNotification["params"]);
    } else if (m?.method === "ui/notifications/host-context-changed") {
      host.context = { ...host.context, ...(m.params as McpUiHostContext) };
      on.context(host.context);
    } else if (m?.method === "ping" && m.id !== undefined) {
      post({ id: m.id, result: {} });
    }
  });

  const init = await host.request("ui/initialize", {
    appInfo,
    appCapabilities: {},
    protocolVersion: PROTOCOL_VERSION,
  });
  host.context = init.hostContext ?? {};
  on.context(host.context);
  notify({ method: "ui/notifications/initialized", params: {} });

  let last = "";
  new ResizeObserver(() => {
    const { width, height } = document.documentElement.getBoundingClientRect();
    const size = `${Math.ceil(width)}x${Math.ceil(height)}`;
    if (size === last) return;
    last = size;
    notify({
      method: "ui/notifications/size-changed",
      params: { width: Math.ceil(width), height: Math.ceil(height) },
    });
  }).observe(document.documentElement);
  return host;
}
