import type { Metadata } from "next";
import { EnvironmentTable } from "../../components/judge/environment";
import { StatusPage } from "../../components/judge/status";
import { LogBonds } from "../../components/log-bond";
import { Eyebrow } from "../../components/notice";

export const metadata: Metadata = {
  title: "Status",
  description:
    "Live health of every dependency Keelson runs on, and whether it is sandbox, testnet or production.",
};

export default function Page() {
  return (
    <div className="grid gap-12">
      <div className="grid max-w-3xl gap-4">
        <Eyebrow>Status</Eyebrow>
        <h1 className="text-balance font-semibold text-4xl leading-[1.05] tracking-[-0.03em] sm:text-5xl">
          Is Keelson up?
        </h1>
        <p className="max-w-prose text-pretty text-lg text-muted-foreground">
          Read live from the API every 30 seconds. PayPal runs on its sandbox and the contracts on
          Arbitrum Sepolia, so no real money moves; the TEEs, the log and the models are the real
          thing.
        </p>
      </div>
      <StatusPage />
      <section aria-labelledby="bonds-title" className="grid gap-4">
        <div className="grid max-w-prose gap-2">
          <h2 id="bonds-title" className="font-semibold text-xl tracking-tight">
            Bonds on the log
          </h2>
          <p className="text-pretty text-muted-foreground">
            Two checkpoints of the log, signed by its key, with different roots for one size slash
            its bond: a bounty to whoever submits them, the rest to Keelson&apos;s reserve. The
            contract verifies the signatures on chain.
          </p>
        </div>
        <LogBonds />
      </section>
      <section aria-labelledby="env-title" className="grid gap-4">
        <h2 id="env-title" className="font-semibold text-xl tracking-tight">
          Where each piece runs
        </h2>
        <EnvironmentTable />
      </section>
    </div>
  );
}
