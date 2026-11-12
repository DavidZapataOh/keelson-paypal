#!/usr/bin/env node
// The Keelson Context Plugin over STDIO: `claude mcp add keelson-docs -- npx @keelson-finance/context`.
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createContextServer } from "./index.ts";

await createContextServer().connect(new StdioServerTransport());
