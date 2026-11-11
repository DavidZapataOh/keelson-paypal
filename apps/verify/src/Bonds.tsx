import { useEffect, useState } from "react";
import { type BondView, readBonds } from "./bonds";

const EXPLORER = "https://sepolia.arbiscan.io";
const pyusd = (v: bigint) =>
  `${(Number(v) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2 })} PYUSD`;
const short = (v: string) => `${v.slice(0, 8)}…${v.slice(-6)}`;

/** The bonds on the log's keys, read from the chain: what an equivocating log would lose. */
export function Bonds({ rpc }: { rpc?: string | undefined }) {
  const [bonds, setBonds] = useState<BondView[] | { error: string }>();
  useEffect(() => {
    readBonds(rpc).then(setBonds, (e: Error) => setBonds({ error: e.message }));
  }, [rpc]);
  return (
    <section aria-labelledby="bonds" className="space-y-3">
      <div>
        <h3 id="bonds" className="font-mono text-xs uppercase tracking-wider text-muted-foreground">
          The log's bonds · Arbitrum Sepolia
        </h3>
        <p className="mt-1 max-w-prose text-sm text-muted-foreground">
          Two checkpoints signed by the log's key with different roots for one size slash its bond:
          a bounty to whoever submits them, the rest to Keelson's reserve. The contract verifies
          both Ed25519 signatures; read from the chain, not from Keelson.
        </p>
      </div>
      {!bonds ? (
        <p className="text-sm text-muted-foreground" role="status">
          Reading the bonds…
        </p>
      ) : "error" in bonds ? (
        <p className="text-sm text-warn">The chain could not be read: {bonds.error}</p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {bonds.map((b) => (
            <li key={b.address} className="space-y-2 py-3" data-bond={b.address}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-sm">
                  {b.origin}
                  {b.origin.includes("/conformance/") && (
                    <span className="ml-2 text-xs text-muted-foreground">test origin · drill</span>
                  )}
                </p>
                <p
                  className={`text-sm ${b.slash ? "text-vermilion-deep" : "text-ok"}`}
                  data-slashed={Boolean(b.slash)}
                >
                  {b.slash
                    ? `Slashed ${pyusd(b.slash.amount)}: ${pyusd(b.slash.bounty)} to ${short(b.slash.prover)}, the rest to Keelson's reserve`
                    : `Bonded: ${pyusd(b.balance)}`}
                </p>
              </div>
              {!b.canonical && (
                <p className="text-sm text-warn">
                  Not Keelson's Ed25519 verifier over PYUSD: a slash of it proves nothing.
                </p>
              )}
              <p className="font-mono text-xs text-muted-foreground">
                key {short(b.key)} ·{" "}
                <a
                  className="underline hover:text-graphite"
                  href={`${EXPLORER}/address/${b.address}`}
                  target="_blank"
                  rel="noopener"
                >
                  {short(b.address)}
                </a>
                {b.slash?.tx && (
                  <>
                    {" · "}
                    <a
                      className="underline hover:text-graphite"
                      href={`${EXPLORER}/tx/${b.slash.tx}`}
                      target="_blank"
                      rel="noopener"
                      data-proof
                    >
                      slash transaction
                    </a>
                  </>
                )}
              </p>
              {b.slash?.notes && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {b.slash.notes.map((n, i) => (
                    <figure key={n} className="space-y-1">
                      <figcaption className="text-xs text-muted-foreground">
                        Signed checkpoint {i ? "B" : "A"}
                      </figcaption>
                      <pre className="overflow-x-auto rounded-md border border-border p-2 font-mono text-[11px] leading-relaxed">
                        {n}
                      </pre>
                    </figure>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
