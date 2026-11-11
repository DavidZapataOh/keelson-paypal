import type { ReactNode } from "react";

/** A page's title, one line under it, and the longer explanation folded away. */
export function PageHead({
  title,
  line,
  more,
  moreLabel = "How this works",
}: {
  title: string;
  line: ReactNode;
  more?: ReactNode;
  moreLabel?: string;
}) {
  return (
    <div className="mb-6 grid max-w-3xl gap-2">
      <h1 className="text-balance font-semibold text-[1.75rem] leading-[1.1] tracking-[-0.025em]">
        {title}
      </h1>
      <p className="text-pretty text-lg text-muted-foreground leading-snug">{line}</p>
      {more ? (
        <details className="group mt-1 w-fit max-w-prose">
          <summary className="cursor-pointer list-none py-1 font-medium text-sm underline-offset-4 hover:underline">
            {moreLabel}
          </summary>
          <div className="mt-2 grid gap-2 text-muted-foreground text-sm leading-relaxed">
            {more}
          </div>
        </details>
      ) : null}
    </div>
  );
}
