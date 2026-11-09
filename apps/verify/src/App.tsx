import type { ChainReader, Check, Report as VerifyReport } from "@keelson/alibi/verify";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { Loaded } from "./load.ts";
import { Report } from "./Report.tsx";
import { parseRoute, type Route, verifyLinkOf } from "./route.ts";
import { loader, memoized, verifier } from "./verifier.ts";

const Cheat = lazy(() => import("./Cheat.tsx"));
const VERIFY_ORIGIN = "https://verify.keelson.finance";

interface Run {
  checks: Check[];
  report?: VerifyReport;
}

const isReceipt = (l: Loaded) => !("type" in l.alibi);
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One reader per RPC choice, memoized so edits re-verify without asking the chain again. */
const readerFor = (rpc: string | undefined): Promise<ChainReader> =>
  verifier.then(({ createChainReader }) =>
    memoized(createChainReader(rpc ? { rpc: { 421614: rpc, 42161: rpc } } : {})),
  );

function download(l: Loaded) {
  const name = `${l.alibi.alibi_id}${isReceipt(l) ? ".receipt.json" : ".alibi"}`;
  const url = URL.createObjectURL(
    new Blob([l.bytes as Uint8Array<ArrayBuffer>], {
      type: "application/vnd.keelson.alibi.v1+json",
    }),
  );
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location));
  const [loaded, setLoaded] = useState<Loaded>();
  const [error, setError] = useState<string>();
  const [run, setRun] = useState<Run>();
  const [edited, setEdited] = useState<unknown>();
  const [changed, setChanged] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  const [rpcInput, setRpcInput] = useState(route.rpc ?? "");
  const [dragging, setDragging] = useState(false);
  const runId = useRef(0);
  const fromUser = useRef(false);

  const chain = useRef(readerFor(route.rpc));

  const verify = useCallback(
    async (alibi: Loaded["alibi"], original?: Loaded["alibi"]) => {
      const id = ++runId.current;
      setRun({ checks: [] });
      const { verifyAlibi } = await verifier;
      const checks: Check[] = [];
      const report = await verifyAlibi(alibi, {
        chain: await chain.current,
        ...(route.expect && route.alibiId === alibi.alibi_id ? { expect: route.expect } : {}),
        ...(original ? { original } : {}),
        onCheck: (c) => {
          checks.push(c);
          if (id === runId.current) setRun({ checks: [...checks] });
        },
      });
      if (id === runId.current) setRun({ checks: report.checks, report });
      return report;
    },
    [route],
  );

  const accept = useCallback(
    async (l: Loaded) => {
      setError(undefined);
      setLoaded(l);
      const { expand } = await verifier;
      setEdited(expand(l.alibi));
      setChanged([]);
      await verify(l.alibi);
    },
    [verify],
  );

  const fail = (err: unknown) => setError(messageOf(err));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  // A link alone loads the public receipt; a dropped file replaces it.
  useEffect(() => {
    if (!route.alibiId) return;
    const ctl = new AbortController();
    loader
      .then(({ fromLink }) => fromLink(route.alibiId as string, ctl.signal))
      .then((l) => {
        if (!fromUser.current) return accept(l);
      })
      .catch((err: unknown) => {
        if (!ctl.signal.aborted) setError(messageOf(err));
      });
    return () => ctl.abort();
  }, [route.alibiId, accept]);

  const onFile = async (file: File) => {
    try {
      const { fromFile, isImage, qrTextOf } = await loader;
      if (isImage(file)) {
        const next = verifyLinkOf(await qrTextOf(file), [VERIFY_ORIGIN, location.origin]);
        if (!next?.alibiId) throw new Error("The QR code is not a Keelson verify link.");
        const url = new URL(await qrTextOf(file));
        history.pushState(null, "", `${url.pathname}${location.search}${url.hash}`);
        fromUser.current = false;
        setLoaded(undefined);
        setRoute(parseRoute(location));
        return;
      }
      fromUser.current = true;
      await accept(await fromFile(file));
    } catch (err) {
      fail(err);
    }
  };

  const onEdit = async (next: unknown) => {
    if (!loaded) return;
    setEdited(next);
    const { collapse } = await verifier;
    const report = await verify(collapse(next), loaded.alibi);
    setChanged(report.changed);
  };

  const onReset = async () => {
    if (!loaded) return;
    const { expand } = await verifier;
    setEdited(expand(loaded.alibi));
    setChanged([]);
    await verify(loaded.alibi);
  };

  const applyRpc = (value: string) => {
    const url = new URL(location.href);
    if (value) url.searchParams.set("rpc", value);
    else url.searchParams.delete("rpc");
    history.replaceState(null, "", url);
    const next = parseRoute(location);
    setRoute(next);
    if (next.rpcRefused) {
      setError(next.rpcRefused);
      return;
    }
    chain.current = readerFor(next.rpc);
    if (loaded) void verify(loaded.alibi);
  };

  return (
    <div className="mx-auto max-w-5xl px-5 pb-24 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <a href="https://keelson.finance" className="flex items-center gap-3">
          <img src="/keelson.svg" alt="Keelson" width="94" height="28" />
          <span className="font-mono text-xs text-ink-2">Alibi verifier</span>
        </a>
        <a
          className="text-sm text-ink-2 hover:text-graphite"
          href="https://github.com/DavidZapataOh/keelson-paypal/tree/main/apps/verify"
        >
          Source
        </a>
      </header>

      <main className="space-y-8">
        <section>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl">
            Check an Alibi without trusting Keelson.
          </h1>
          <p className="mt-3 max-w-2xl text-lg text-ink-2">
            Every check runs in this browser against trust roots pinned in the code, the public
            transparency log and Arbitrum. Drop the PDF, the .alibi file or a photo of its QR code.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
          <label
            className={`flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-[14px] border-2 border-dashed p-6 text-center transition-colors ${dragging ? "border-vermilion bg-bone-2" : "border-line"}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files[0];
              if (f) void onFile(f);
            }}
          >
            <span className="text-base font-medium">Drop an Alibi here, or choose a file</span>
            <span className="mt-1 text-sm text-ink-2">
              PDF, .alibi, .json or a QR image · up to 8 MB
            </span>
            <input
              type="file"
              className="sr-only"
              accept=".pdf,.alibi,.json,application/pdf,application/json,image/*"
              data-testid="file"
              onChange={(e) => {
                const f = e.currentTarget.files?.[0];
                if (f) void onFile(f);
                e.currentTarget.value = "";
              }}
            />
          </label>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              fromUser.current = true;
              loader.then(({ fromText }) => accept(fromText(paste))).catch(fail);
            }}
          >
            <textarea
              aria-label="Paste an Alibi as JSON"
              placeholder="…or paste its JSON"
              className="min-h-28 flex-1 rounded-[10px] border border-line bg-bone p-3 font-mono text-xs"
              value={paste}
              onChange={(e) => setPaste(e.currentTarget.value)}
            />
            <button
              type="submit"
              className="rounded-md bg-graphite px-4 py-2 text-sm font-medium text-bone hover:bg-graphite-2 disabled:opacity-40"
              disabled={!paste.trim()}
            >
              Verify pasted JSON
            </button>
          </form>
        </section>

        {error && (
          <p
            role="alert"
            className="rounded-[10px] border border-vermilion px-4 py-3 text-vermilion-deep"
          >
            {error}
          </p>
        )}

        {run && loaded && (
          <>
            <Report checks={run.checks} report={run.report} receipt={isReceipt(loaded)} />
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-graphite"
                onClick={() => download(loaded)}
              >
                Download this Alibi
              </button>
              <span className="font-mono text-xs text-ink-2">{loaded.alibi.alibi_id}</span>
            </div>
            {edited !== undefined && (
              <Suspense fallback={null}>
                <Cheat edited={edited} changed={changed} onChange={onEdit} onReset={onReset} />
              </Suspense>
            )}
          </>
        )}

        <section className="rounded-[14px] border border-line p-6">
          <h2 className="text-base font-medium">Arbitrum RPC</h2>
          <p className="mt-1 text-sm text-ink-2">
            The anchor and the signer registry are read from a public Arbitrum RPC. Use your own to
            trust nobody else's: it must be https.
          </p>
          <form
            className="mt-3 flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              applyRpc(rpcInput.trim());
            }}
          >
            <input
              aria-label="RPC URL"
              className="min-w-64 flex-1 rounded-md border border-line bg-bone px-3 py-1.5 font-mono text-sm"
              placeholder="https://sepolia-rollup.arbitrum.io/rpc"
              value={rpcInput}
              onChange={(e) => setRpcInput(e.currentTarget.value)}
            />
            <button
              type="submit"
              className="rounded-md border border-line px-3 py-1.5 text-sm hover:border-graphite"
            >
              Use this RPC
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
