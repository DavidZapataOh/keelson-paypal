import type { ChainReader, Check, Report as VerifyReport } from "@keelson/alibi/verify";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Anonymous } from "./Anonymous.tsx";
import { Bonds } from "./Bonds.tsx";
import type { Loaded } from "./load.ts";
import { Report } from "./Report.tsx";
import { parseRoute, type Route, verifyLinkOf } from "./route.ts";
import { loader, memoized, verifier } from "./verifier.ts";

const Cheat = lazy(() => import("./Cheat.tsx"));
const Amber = lazy(() => import("./Amber.tsx"));
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location));
  const [loaded, setLoaded] = useState<Loaded>();
  const [run, setRun] = useState<Run>();
  // The Alibi the report is of: the loaded one, or the visitor's edit of it.
  const [current, setCurrent] = useState<Loaded["alibi"]>();
  const [rpc, setRpc] = useState<string>();
  const [edited, setEdited] = useState<unknown>();
  const [changed, setChanged] = useState<string[]>([]);
  const [paste, setPaste] = useState("");
  // A link may suggest an RPC; it is used only once the visitor chooses it.
  const [rpcInput, setRpcInput] = useState(route.rpc ?? "");
  const [error, setErrorState] = useState<string | undefined>(route.rpcRefused);
  const [dragging, setDragging] = useState(false);
  const runId = useRef(0);
  const fromUser = useRef(false);

  const setError = setErrorState;
  const chain = useRef(readerFor(undefined));

  const verify = useCallback(
    async (alibi: Loaded["alibi"], original?: Loaded["alibi"]) => {
      const id = ++runId.current;
      setRun({ checks: [] });
      setCurrent(alibi);
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
      setRun(undefined);
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
        if (l.alibi.alibi_id !== route.alibiId) {
          throw new Error("The API answered with another Alibi than the link names.");
        }
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
        const text = await qrTextOf(file);
        const next = verifyLinkOf(text, [VERIFY_ORIGIN, location.origin]);
        if (!next?.alibiId) throw new Error("The QR code is not a Keelson verify link.");
        const url = new URL(text);
        history.pushState(null, "", `${url.pathname}${location.search}${url.hash}`);
        fromUser.current = false;
        setLoaded(undefined);
        setRoute(parseRoute(location));
        return;
      }
      const l = await fromFile(file);
      fromUser.current = true;
      await accept(l);
    } catch (err) {
      fail(err);
    }
  };

  const onEdit = async (next: unknown) => {
    if (!loaded) return;
    setEdited(next);
    const { collapse } = await verifier;
    let collapsed: Loaded["alibi"];
    try {
      collapsed = collapse(next);
    } catch (err) {
      ++runId.current;
      setRun(undefined);
      setError(`This edit cannot be encoded as an Alibi: ${messageOf(err)}`);
      return;
    }
    setError(undefined);
    const id = runId.current + 1;
    const report = await verify(collapsed, loaded.alibi);
    if (id === runId.current) setChanged(report.changed);
  };

  const onReset = async () => {
    if (!loaded) return;
    const { expand } = await verifier;
    setEdited(expand(loaded.alibi));
    setChanged([]);
    setError(undefined);
    await verify(loaded.alibi);
  };

  // The RPC stays out of the URL, so a key in it is never shared with the link.
  const applyRpc = (value: string) => {
    const next = value
      ? parseRoute({ pathname: "/", hash: "", search: `?rpc=${encodeURIComponent(value)}` })
      : {};
    if (next.rpcRefused) {
      setError(next.rpcRefused);
      return;
    }
    setError(undefined);
    chain.current = readerFor(next.rpc);
    setRpc(next.rpc);
    if (loaded) void verify(loaded.alibi);
  };

  if (route.embed) {
    const full = `${location.origin}${location.pathname}${location.hash}`;
    return (
      <main className="space-y-6 p-4 sm:p-6">
        {error && (
          <p
            role="alert"
            className="rounded-[10px] border border-vermilion px-4 py-3 text-vermilion-deep"
          >
            {error}
          </p>
        )}
        {route.anonymous && current ? (
          <Anonymous alibi={current} rpc={rpc} />
        ) : run && loaded && edited !== undefined ? (
          <>
            {current && <Anonymous alibi={current} rpc={rpc} />}
            <Suspense fallback={null}>
              <Cheat edited={edited} changed={changed} onChange={onEdit} onReset={onReset} embed />
            </Suspense>
            <Report checks={run.checks} report={run.report} receipt={isReceipt(loaded)} />
          </>
        ) : (
          !error && (
            <p className="text-muted-foreground" role="status">
              Loading the Alibi's public receipt…
            </p>
          )
        )}
        <a
          className="inline-block text-sm text-muted-foreground underline hover:text-graphite"
          href={full}
          target="_blank"
          rel="noopener"
        >
          Open in the full verifier
        </a>
      </main>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-5 pb-24 sm:px-8">
      <header className="flex items-center justify-between py-6">
        <a href="https://keelson.finance" className="flex items-center gap-3">
          <img src="/keelson.svg" alt="Keelson" width="94" height="28" />
          <span className="font-mono text-xs text-muted-foreground">Alibi verifier</span>
        </a>
        <a
          className="text-sm text-muted-foreground hover:text-graphite"
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
          <p className="mt-3 max-w-2xl text-lg text-muted-foreground">
            Every check runs in this browser against trust roots pinned in the code, the public
            transparency log and Arbitrum. Drop the PDF, the .alibi file or a photo of its QR code.
          </p>
        </section>

        <section className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
          <label
            className={`flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-[14px] border-2 border-dashed p-6 text-center transition-colors ${dragging ? "border-vermilion bg-bone-2" : "border-border"}`}
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
            <span className="mt-1 text-sm text-muted-foreground">
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
              className="min-h-28 flex-1 rounded-[10px] border border-border bg-bone p-3 font-mono text-xs"
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

        {route.alibiId && !run && !error && (
          // Holds the report's place, so what follows does not move when the receipt lands.
          <p role="status" className="min-h-dvh text-muted-foreground">
            Loading the Alibi's public receipt…
          </p>
        )}

        {run && loaded && (
          <div className="space-y-8" data-run={runId.current}>
            {route.alibiId === loaded.alibi.alibi_id && !route.expect && (
              <p className="rounded-[10px] border border-warn px-4 py-3 text-sm text-warn">
                This link carries no leaf hash, so which Alibi it names is the API's word. Links
                from an Alibi's QR code carry one.
              </p>
            )}
            {route.anonymous && current && <Anonymous alibi={current} rpc={rpc} />}
            <Report checks={run.checks} report={run.report} receipt={isReceipt(loaded)} />
            {!route.anonymous && current && <Anonymous alibi={current} rpc={rpc} />}
            <Bonds rpc={route.rpc} />
            <Suspense fallback={null}>
              <Amber alibiId={loaded.alibi.alibi_id} rpc={rpc} />
            </Suspense>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-graphite"
                onClick={() => download(loaded)}
              >
                Download this Alibi
              </button>
              <span className="font-mono text-xs text-muted-foreground">
                {loaded.alibi.alibi_id}
              </span>
            </div>
            {edited !== undefined && (
              <Suspense fallback={null}>
                <Cheat edited={edited} changed={changed} onChange={onEdit} onReset={onReset} />
              </Suspense>
            )}
          </div>
        )}

        <section className="rounded-[14px] border border-border p-6">
          <h2 className="text-base font-medium">Arbitrum RPC</h2>
          <p className="mt-1 text-sm text-muted-foreground">
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
              className="min-w-64 flex-1 rounded-md border border-border bg-bone px-3 py-1.5 font-mono text-sm"
              placeholder="https://sepolia-rollup.arbitrum.io/rpc"
              value={rpcInput}
              onChange={(e) => setRpcInput(e.currentTarget.value)}
            />
            <button
              type="submit"
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-graphite"
            >
              Use this RPC
            </button>
          </form>
        </section>
      </main>
    </div>
  );
}
