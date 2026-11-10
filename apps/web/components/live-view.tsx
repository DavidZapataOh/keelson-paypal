/**
 * The agent's browser while it shops under the mandate: Kernel's live view, read-only, so the
 * owner watches without being able to click for the agent.
 */
export function LiveView({ url }: { url: string }) {
  return (
    <section className="grid max-w-3xl gap-3" aria-labelledby="live">
      <div className="flex items-center gap-2">
        <span className="relative flex size-2" aria-hidden="true">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-vermilion opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-2 rounded-full bg-vermilion" />
        </span>
        <h2 id="live" className="font-semibold text-xl">
          Your agent is shopping
        </h2>
      </div>
      <p className="text-muted-foreground text-sm">
        Its browser, live. Keelson checks the cart against this mandate before any money moves.
      </p>
      <iframe
        src={url}
        title="The agent's browser, live and read-only"
        className="aspect-[1280/800] w-full rounded-xl border bg-muted"
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        allow=""
      />
    </section>
  );
}
