import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keelson/ui/components/table";
import { ENVIRONMENTS, type Health, type StatusReport } from "../../lib/judge";

/** Which dependency runs where: sandbox, testnet or production. */
export function EnvironmentTable() {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Dependency</TableHead>
          <TableHead>Runs on</TableHead>
          <TableHead className="hidden sm:table-cell">What it does here</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ENVIRONMENTS.map((e) => (
          <TableRow key={e.dependency}>
            <TableCell className="font-medium whitespace-normal">{e.dependency}</TableCell>
            <TableCell className="font-mono text-sm">{e.env}</TableCell>
            <TableCell className="hidden whitespace-normal text-muted-foreground sm:table-cell">
              {e.what}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

const WORD: Record<Health, string> = { up: "Operational", degraded: "Degraded", down: "Down" };

function age(ms: number | null): string {
  if (ms === null) return "never";
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s ago`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
}

function Row({
  name,
  health,
  env,
  detail,
}: {
  name: string;
  health: Health;
  env: string;
  detail?: string;
}) {
  return (
    <li className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
      <span className="grid gap-0.5">
        <span className="font-medium">{name}</span>
        {detail ? <span className="font-mono text-muted-foreground text-xs">{detail}</span> : null}
      </span>
      <span className="flex items-center gap-3 text-sm">
        <span className="font-mono text-muted-foreground text-xs">{env}</span>
        <span
          data-health={health}
          className="inline-flex items-center gap-1.5 font-medium data-[health=degraded]:text-warn data-[health=up]:text-ok data-[health=down]:text-foreground"
        >
          <span aria-hidden="true" className="font-mono">
            {health === "up" ? "●" : health === "degraded" ? "◐" : "!"}
          </span>
          {WORD[health]}
        </span>
      </span>
    </li>
  );
}

/** The API's dependency report, one row per dependency, in words. */
export function HealthList({ report }: { report: StatusReport }) {
  const d = report.dependencies;
  const chain = d.relayer.chains[0];
  return (
    <ul className="divide-y rounded-lg border bg-card px-5">
      <Row
        name="PayPal"
        health={d.paypal.status}
        env={d.paypal.environment === "sandbox" ? "Sandbox" : "Production"}
        detail={`webhook ${age(d.webhooks.lastWebhookAgeMs)} · poll ${age(d.webhooks.lastPollAgeMs)}`}
      />
      <Row name="TEE leg A · Intel TDX" health={d.teeA} env="Production" />
      <Row name="TEE leg B · AWS Nitro" health={d.teeB} env="Production" />
      <Row
        name="Alibi log"
        health={d.log.status}
        env="Production"
        detail={d.log.origins
          .map((o) => `${o.origin.split("/").slice(1).join("/")} · ${o.size} entries`)
          .join("  ")}
      />
      <Row
        name="Checkpoint anchor"
        health={d.anchor.status}
        env="Testnet"
        detail={`size ${d.anchor.size} · anchored ${age(d.anchor.anchoredAgeMs)}`}
      />
      <Row
        name="Relayer · Arbitrum Sepolia"
        health={d.relayer.status}
        env="Testnet"
        {...(chain ? { detail: `${chain.pending} pending` } : {})}
      />
      <Row name="Database" health={d.db} env="Production" />
      <Row name="Event bus" health={d.kv} env="Production" />
    </ul>
  );
}
