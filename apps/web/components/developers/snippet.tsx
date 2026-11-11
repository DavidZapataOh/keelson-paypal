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
    <div className="relative min-w-0 rounded-xl bg-graphite text-bone">
      <pre className="whitespace-pre-wrap break-all px-4 py-3.5 pr-12 font-mono text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
      <button
        type="button"
        aria-label={copied ? `${label} copied` : `Copy ${label}`}
        onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true))}
        className="absolute top-2 right-2 grid size-8 place-items-center rounded-lg bg-graphite text-bone/70 shadow-[-12px_0_12px_var(--color-graphite)] hover:text-bone"
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
