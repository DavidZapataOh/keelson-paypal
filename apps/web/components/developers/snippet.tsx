"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/** A block of code on graphite, with a copy button that says when it copied. */
export function Snippet({ code, label }: { code: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    // The button has a column of its own, so it never covers code; long lines wrap.
    <div className="grid min-w-0 grid-cols-[1fr_auto] items-start gap-2 rounded-xl bg-graphite py-2 pr-2 pl-4 text-bone">
      <pre className="min-w-0 whitespace-pre-wrap py-1.5 font-mono text-[13px] leading-relaxed [overflow-wrap:anywhere]">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}
        className="grid size-8 place-items-center rounded-lg bg-bone/10 text-bone/80 hover:bg-bone/20 hover:text-bone"
      >
        {copied ? (
          <Check className="size-4" aria-hidden="true" />
        ) : (
          <Copy className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
