import { valueAt } from "@keelson/alibi/verify";
import { useState } from "react";
import { PRESETS, setAt } from "./presets.ts";

const escapeKey = (k: string) => k.replaceAll("~", "~0").replaceAll("/", "~1");

/** Parses an edit back to the type of the value it replaces. */
function coerce(old: unknown, text: string): unknown {
  if (typeof old === "number") {
    const n = Number(text);
    return Number.isFinite(n) ? n : text;
  }
  if (typeof old === "boolean") return text === "true";
  if (old === null) return text === "null" ? null : text;
  return text;
}

function Scalar({
  path,
  value,
  changed,
  onEdit,
}: {
  path: string;
  value: unknown;
  changed: boolean;
  onEdit: (p: string, v: unknown) => void;
}) {
  const text = value === null ? "null" : String(value);
  const commit = (next: string) => {
    if (next !== text) onEdit(path, coerce(value, next));
  };
  const cls = `w-full rounded-md border bg-bone px-2 py-1 font-mono text-xs ${changed ? "border-vermilion" : "border-border"}`;
  const name = path.split("/").at(-1);
  return (
    <div className="grid grid-cols-[minmax(6rem,12rem)_1fr] items-start gap-2 py-1">
      <span className="truncate pt-1 font-mono text-xs text-muted-foreground" title={path}>
        {name}
      </span>
      {text.length > 80 ? (
        <textarea
          key={text}
          className={cls}
          rows={3}
          defaultValue={text}
          data-pointer={path}
          aria-label={path}
          onBlur={(e) => commit(e.currentTarget.value)}
        />
      ) : (
        <input
          key={text}
          className={cls}
          defaultValue={text}
          data-pointer={path}
          aria-label={path}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit(e.currentTarget.value);
          }}
        />
      )}
    </div>
  );
}

function Node({
  name,
  path,
  value,
  changed,
  onEdit,
  open: initiallyOpen = false,
}: {
  name: string;
  path: string;
  value: unknown;
  changed: readonly string[];
  onEdit: (p: string, v: unknown) => void;
  open?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  if (value === null || typeof value !== "object") {
    return <Scalar path={path} value={value} changed={changed.includes(path)} onEdit={onEdit} />;
  }
  const entries = Object.entries(value);
  const touched = changed.some((p) => p.startsWith(`${path}/`));
  return (
    <details
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="border-l border-border pl-3"
    >
      <summary
        className={`cursor-pointer py-1 font-mono text-xs ${touched ? "text-vermilion-deep" : ""}`}
      >
        {name}{" "}
        <span className="text-muted-foreground">
          {Array.isArray(value) ? `[${entries.length}]` : `{${entries.length}}`}
        </span>
      </summary>
      {open &&
        entries.map(([k, v]) => (
          <Node
            key={k}
            name={k}
            path={`${path}/${escapeKey(k)}`}
            value={v}
            changed={changed}
            onEdit={onEdit}
          />
        ))}
    </details>
  );
}

/** An editor over an expanded copy of the Alibi; every edit stays in this page. */
export default function Cheat({
  edited,
  changed,
  onChange,
  onReset,
  embed = false,
}: {
  edited: unknown;
  changed: readonly string[];
  onChange: (next: unknown) => void;
  onReset: () => void;
  /** Framed on another page: only the cheats that apply, and the field editor folded. */
  embed?: boolean;
}) {
  const onEdit = (p: string, v: unknown) => onChange(setAt(edited, p, v));
  return (
    <section aria-labelledby="cheat" className="rounded-[14px] border border-border p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 id="cheat" className="text-xl font-semibold tracking-tight">
          Try to cheat
        </h2>
        <button
          type="button"
          className="rounded-md border border-border px-3 py-1 text-sm hover:border-graphite disabled:opacity-40"
          onClick={onReset}
          disabled={changed.length === 0}
        >
          Reset to the original
        </button>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Edit any field of this local copy and see which check catches it. Nothing you edit leaves
        the browser.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {PRESETS.map((preset) => {
          const p = preset.pointer(edited);
          if (embed && !p) return null;
          return (
            <button
              key={preset.id}
              type="button"
              data-preset={preset.id}
              disabled={!p}
              className="rounded-md bg-graphite px-3 py-1.5 text-sm text-bone hover:bg-graphite-2 disabled:opacity-40"
              onClick={() => {
                if (!p) return;
                onEdit(p, preset.value(valueAt(edited, p)));
              }}
            >
              {preset.label}
            </button>
          );
        })}
      </div>
      <div className="mt-4 max-h-[32rem] overflow-auto">
        <Node
          name={embed ? "all fields" : "alibi"}
          path=""
          value={edited}
          changed={changed}
          onEdit={onEdit}
          open={!embed}
        />
      </div>
    </section>
  );
}
