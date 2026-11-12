"use client";

import { Button } from "@keelson/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@keelson/ui/components/sheet";
import { Check, Download, Loader2 } from "lucide-react";
import { useState } from "react";
import { API, VERIFY } from "../lib/config";
import { EXPORTS, type ExportFormat, refusalOf } from "../lib/exports";

type RowState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "saved" }
  | { kind: "refused"; reason: string };

/** Downloads one export; a refusal comes back as its reason. */
async function save(id: string, f: ExportFormat): Promise<RowState> {
  const res = await fetch(`${API}/v1/alibis/${id}/exports/${f.format}`, { credentials: "include" });
  if (res.status === 409 || res.status === 503) {
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    return { kind: "refused", reason: body.reason ?? "unavailable" };
  }
  if (!res.ok) return { kind: "refused", reason: "unavailable" };
  const url = URL.createObjectURL(await res.blob());
  Object.assign(document.createElement("a"), { href: url, download: `${id}.${f.file}` }).click();
  URL.revokeObjectURL(url);
  return { kind: "saved" };
}

/**
 * The purchase in the industry's standards, each file signed inside Keelson's attested enclave and
 * carrying the purchase's transparency-log statement.
 */
export function AlibiExports({ id, denied = false }: { id: string; denied?: boolean }) {
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const stateOf = (f: ExportFormat): RowState =>
    rows[f.format] ??
    (denied && (f.format === "acp" || f.format === "tap")
      ? { kind: "refused", reason: "denied" }
      : { kind: "idle" });
  const run = async (f: ExportFormat) => {
    setRows((r) => ({ ...r, [f.format]: { kind: "busy" } }));
    const next = await save(id, f).catch(
      () => ({ kind: "refused", reason: "unavailable" }) as RowState,
    );
    setRows((r) => ({ ...r, [f.format]: next }));
  };
  const group = (g: ExportFormat["group"], title: string) => (
    <section aria-label={title} className="grid gap-2">
      <h3 className="font-medium text-muted-foreground text-xs">{title}</h3>
      <ul className="divide-y rounded-xl border">
        {EXPORTS.filter((f) => f.group === g).map((f) => {
          const s = stateOf(f);
          return (
            <li key={f.format} className="flex items-start justify-between gap-3 px-4 py-3">
              <div className="grid min-w-0 gap-0.5">
                <span className="font-medium">{f.name}</span>
                <span className="text-muted-foreground text-xs">{f.reader}</span>
                {s.kind === "refused" ? (
                  <span className="text-xs" role="status">
                    {refusalOf(s.reason)}
                  </span>
                ) : (
                  <span className="text-muted-foreground text-xs">
                    Checked with {f.checkedWith}
                  </span>
                )}
              </div>
              {s.kind === "refused" ? null : (
                <Button
                  variant="outline"
                  size="icon"
                  aria-label={`Download ${f.name}`}
                  disabled={s.kind === "busy"}
                  onClick={() => run(f)}
                >
                  {s.kind === "busy" ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : s.kind === "saved" ? (
                    <Check aria-hidden="true" />
                  ) : (
                    <Download aria-hidden="true" />
                  )}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button variant="outline">Use this Alibi elsewhere</Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Use this Alibi elsewhere</SheetTitle>
          <SheetDescription>
            The same purchase in the formats agents, stores, card networks and issuers already read.
          </SheetDescription>
        </SheetHeader>
        <div className="grid gap-5 overflow-y-auto px-4 pb-6 text-sm">
          {group("protocols", "Agent payment protocols")}
          {group("disputes", "Disputes")}
          <p className="text-muted-foreground text-xs">
            Signed inside Keelson's attested enclave. Each file carries the purchase's
            transparency-log statement, so anyone can check it without asking us.
          </p>
          <a
            className="text-xs underline underline-offset-4"
            href={`${VERIFY}/?export`}
            target="_blank"
            rel="noopener"
          >
            Verify a file you received
          </a>
        </div>
      </SheetContent>
    </Sheet>
  );
}
