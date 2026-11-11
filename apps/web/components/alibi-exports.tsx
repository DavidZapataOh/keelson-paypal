"use client";

import { Button } from "@keelson/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@keelson/ui/components/dropdown-menu";
import { ChevronDown, Download } from "lucide-react";
import { API } from "../lib/config";

interface Format {
  path: string;
  file: string;
  name: string;
  detail: string;
}

const PROTOCOLS: Format[] = [
  {
    path: "ap2",
    file: "ap2.json",
    name: "AP2 v0.2",
    detail: "Mandates and receipts, Google's protocol",
  },
  {
    path: "vi",
    file: "vi.json",
    name: "Verifiable Intent",
    detail: "Mastercard's credential chain",
  },
  { path: "ucp", file: "ucp.json", name: "UCP", detail: "Checkout with its AP2 mandate" },
  { path: "acp", file: "acp.json", name: "ACP", detail: "Delegated payment allowance" },
  { path: "tap", file: "tap.json", name: "Visa TAP", detail: "Signed agent request headers" },
];

const DISPUTES: Format[] = [
  {
    path: "visa.pdf",
    file: "visa-evidence.pdf",
    name: "Visa evidence pack",
    detail: "PDF for a chargeback, §4.1.23 and CE3.0",
  },
  {
    path: "visa",
    file: "visa-evidence.json",
    name: "Visa evidence pack",
    detail: "The same pack as JSON",
  },
];

async function save(id: string, f: Format) {
  const res = await fetch(`${API}/v1/alibis/${id}/exports/${f.path}`, { credentials: "include" });
  if (!res.ok) throw new Error(`The ${f.name} export is not available right now.`);
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: `${id}.${f.file}` }).click();
  URL.revokeObjectURL(url);
}

/** The Alibi in the industry's formats, each downloaded as a file. */
export function AlibiExports({ id, onError }: { id: string; onError: (message: string) => void }) {
  const item = (f: Format) => (
    <DropdownMenuItem
      key={f.path}
      className="grid gap-0.5 py-2"
      onSelect={() => save(id, f).catch((e: Error) => onError(e.message))}
    >
      <span className="font-medium">{f.name}</span>
      <span className="text-muted-foreground text-xs">{f.detail}</span>
    </DropdownMenuItem>
  );
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline">
          <Download aria-hidden />
          Export as
          <ChevronDown aria-hidden className="opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Agent payment protocols</DropdownMenuLabel>
          {PROTOCOLS.map(item)}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Disputes</DropdownMenuLabel>
          {DISPUTES.map(item)}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
