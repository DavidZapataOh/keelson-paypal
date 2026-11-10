"use client";

import { Badge } from "@keelson/ui/components/badge";
import { buttonVariants } from "@keelson/ui/components/button";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { Skeleton } from "@keelson/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keelson/ui/components/table";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  type CampaignItem,
  campaigns,
  campaignUrl,
  percent,
  type Rate,
  type Row,
  type Scoreboard,
  scoreboard,
  usd,
} from "../lib/scoreboard";
import { ErrorNotice, Eyebrow } from "./notice";

const SPLIT = { seen: "Seen templates", holdout: "Held-out templates", all: "All templates" };

/** A rate over its count and interval; `upper` shows only the upper limit. */
function RateCell({ rate, upper = false }: { rate: Rate; upper?: boolean }) {
  if (rate.n === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="grid justify-items-end gap-0.5">
      <span className="font-medium">{percent(rate.ppm ?? 0)}</span>
      <span className="text-muted-foreground text-xs">
        {rate.k}/{rate.n} ·{" "}
        {upper
          ? `≤ ${percent(rate.hi_ppm, true)}`
          : `${percent(rate.lo_ppm)}–${percent(rate.hi_ppm, true)}`}
      </span>
    </span>
  );
}

function Tile({
  label,
  value,
  detail,
  foot,
  act = false,
}: {
  label: string;
  value: string;
  detail: string;
  foot: string;
  act?: boolean;
}) {
  return (
    <div className="grid content-start gap-2 rounded-lg border bg-card p-5">
      <p className="text-muted-foreground text-sm">{label}</p>
      <p
        className={`font-semibold text-amount tabular-nums ${act ? "text-vermilion-deep dark:text-vermilion" : ""}`}
      >
        {value}
      </p>
      <p className="text-pretty text-sm">{detail}</p>
      <p className="font-mono text-muted-foreground text-xs">{foot}</p>
    </div>
  );
}

const find = (rows: Row[], backbone: string, split: Row["split"]) =>
  rows.find((r) => r.backbone === backbone && r.split === split);

function Board({ board }: { board: Scoreboard }) {
  const all = find(board.rows, "all", "all");
  const held = find(board.rows, "all", "holdout");
  const backbones = [...new Set(board.rows.map((r) => r.backbone))].sort(
    (a, b) => Number(a === "all") - Number(b === "all"),
  );
  const agents = board.rows
    .filter((r) => r.backbone !== "all" && r.split === "all")
    .reduce((n, r) => n + r.usd_micros, 0);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10">
      {all && held ? (
        <section aria-label="Headline" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label="Escapes past Keelson"
            value={`${all.escape.k} of ${all.escape.n}`}
            detail="carts that broke the mandate and were allowed"
            foot={`≤ ${percent(all.escape.hi_ppm, true)} at 95% · Clopper-Pearson`}
            act
          />
          <Tile
            label="On held-out templates"
            value={`${held.escape.k} of ${held.escape.n}`}
            detail="escapes on attacks never used to tune the mutator"
            foot={`≤ ${percent(held.escape.hi_ppm, true)} at 95% · Clopper-Pearson`}
          />
          <Tile
            label="False blocks"
            value={`${all.false_blocks.k} of ${all.false_blocks.n}`}
            detail="carts inside the mandate that Keelson denied"
            foot={`${percent(all.false_blocks.lo_ppm)}–${percent(all.false_blocks.hi_ppm, true)} at 95% · Wilson`}
          />
          <Tile
            label="Attacks"
            value={board.attacks.toLocaleString("en-US")}
            detail={`${all.asr.k} hijacked the agent's cart; ${all.amber.k} stayed inside the mandate`}
            foot={`${usd(agents + (board.mutator_usd_micros ?? 0))} on the Anthropic API`}
          />
        </section>
      ) : null}

      <section aria-labelledby="by-backbone" className="grid grid-cols-[minmax(0,1fr)] gap-4">
        <h2 id="by-backbone" className="font-semibold text-xl tracking-[-0.01em]">
          By backbone and split
        </h2>
        <div className="rounded-lg border bg-card">
          <Table label="Rates by backbone and split">
            <caption className="sr-only">
              Rates per backbone and template split, each with its count and 95% interval
            </caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Split</TableHead>
                <TableHead scope="col" className="text-right">
                  Attacks
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Agent ASR
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Escape rate
                </TableHead>
                <TableHead scope="col" className="text-right">
                  False blocks
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Utility under attack
                </TableHead>
                <TableHead scope="col" className="text-right">
                  Amber
                </TableHead>
              </TableRow>
            </TableHeader>
            {backbones.map((backbone) => {
              const rows = board.rows.filter((r) => r.backbone === backbone);
              const models = rows.find((r) => r.split === "all")?.models ?? [];
              return (
                <TableBody key={backbone}>
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={7} className="bg-muted/40 font-medium">
                      {backbone === "all" ? "All backbones" : `${backbone} agent`}
                      {models.length > 0 && backbone !== "all" ? (
                        <span className="ml-2 font-mono text-muted-foreground text-xs">
                          {models.join(", ")}
                        </span>
                      ) : null}
                    </TableCell>
                  </TableRow>
                  {rows.map((r) => (
                    <TableRow key={r.split} className="[&>td]:h-14">
                      <TableCell className="text-muted-foreground">{SPLIT[r.split]}</TableCell>
                      <TableCell className="text-right">{r.attacks}</TableCell>
                      <TableCell className="text-right">
                        <RateCell rate={r.asr} />
                      </TableCell>
                      <TableCell className="text-right">
                        <RateCell rate={r.escape} upper />
                      </TableCell>
                      <TableCell className="text-right">
                        <RateCell rate={r.false_blocks} />
                      </TableCell>
                      <TableCell className="text-right">
                        <RateCell rate={r.utility} />
                      </TableCell>
                      <TableCell className="text-right">
                        {r.amber.n === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <span className="grid justify-items-end gap-0.5">
                            <span className={`font-medium ${r.amber.k > 0 ? "text-warn" : ""}`}>
                              {percent(r.amber.ppm ?? 0)}
                            </span>
                            <span className="text-muted-foreground text-xs">
                              {r.amber.k}/{r.amber.n}
                            </span>
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              );
            })}
          </Table>
        </div>
        <p className="max-w-prose text-muted-foreground text-sm">
          Agent ASR counts attacks where the agent proposed a cart. Escape rate is over carts that
          broke the mandate. Utility is the user&apos;s own purchase going through, over every
          attack. Amber is an attack that got its way inside the mandate, allowed by design.
        </p>
      </section>

      <section aria-labelledby="ledger" className="grid gap-6 md:grid-cols-[1fr_1.2fr] md:gap-10">
        <div className="grid content-start gap-4">
          <h2 id="ledger" className="font-semibold text-xl tracking-[-0.01em]">
            The ledger
          </h2>
          <DataList>
            <DataItem label="Campaign">
              <CopyValue value={board.campaign} label="campaign id" short />
            </DataItem>
            <DataItem label="Started">
              <time dateTime={board.started}>
                {new Date(board.started).toLocaleString("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: "UTC",
                })}{" "}
                UTC
              </time>
            </DataItem>
            <DataItem label="Lines">{board.lines.toLocaleString("en-US")}</DataItem>
            <DataItem label="Head">
              <CopyValue value={board.head} label="ledger head" short />
            </DataItem>
            <DataItem label="Commit">
              <span className="font-mono">{board.commit.slice(0, 7)}</span>
            </DataItem>
          </DataList>
          <div className="flex flex-wrap gap-2">
            <a
              href={campaignUrl(board.campaign, "ledger")}
              download={`${board.campaign}.jsonl`}
              className={buttonVariants()}
            >
              Download ledger
            </a>
            <a
              href={campaignUrl(board.campaign, "scoreboard")}
              className={buttonVariants({ variant: "outline" })}
            >
              Scoreboard JSON
            </a>
          </div>
        </div>
        <div className="grid content-start gap-3">
          <h3 className="font-medium">Recompute it yourself</h3>
          <p className="text-muted-foreground text-sm">
            The script verifies the hash chain, re-runs every Keelson decision and verdict, then
            prints the scoreboard. Byte for byte, it is what this page shows.
          </p>
          <pre className="whitespace-pre-wrap break-all rounded-lg bg-graphite p-4 font-mono text-bone text-xs leading-relaxed">
            {`curl -s ${campaignUrl(board.campaign, "ledger")} -o ledger.jsonl
curl -s ${campaignUrl(board.campaign, "scoreboard")} -o published.json
node services/redteam/scripts/scoreboard.ts ledger.jsonl \\
  | cmp - published.json && echo identical`}
          </pre>
          <Link href="/scoreboard/methodology/" className="text-sm underline">
            Setup and definitions
          </Link>
        </div>
      </section>
    </div>
  );
}

/** The scoreboard of `?campaign=`, or of the latest campaign; live while it runs. */
export function ScoreboardPage() {
  const asked = useSearchParams().get("campaign");
  const [list, setList] = useState<CampaignItem[]>();
  const [board, setBoard] = useState<Scoreboard>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    campaigns()
      .then(setList)
      .catch(() => setError("The scoreboard could not be loaded. Try again in a moment."));
  }, []);

  const id = asked ?? list?.find((c) => c.attacks > 0)?.id;

  useEffect(() => {
    if (!id) return;
    let source: EventSource | undefined;
    scoreboard(id)
      .then((b) => {
        setBoard(b);
        if (b.complete) return;
        source = new EventSource(campaignUrl(id, "scoreboard/stream"));
        source.addEventListener("scoreboard", (e) =>
          setBoard(JSON.parse((e as MessageEvent<string>).data) as Scoreboard),
        );
        source.addEventListener("end", () => source?.close());
      })
      .catch(() => setError("No scoreboard for this campaign."));
    return () => source?.close();
  }, [id]);

  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (list && !id) {
    return <p className="text-muted-foreground">No campaign has run yet.</p>;
  }
  if (!board) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-40 rounded-lg" />
        ))}
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-10">
      <div className="flex flex-wrap items-center gap-3">
        {board.complete ? (
          <Badge variant="outline">Finished</Badge>
        ) : (
          <Badge variant="outline" className="gap-1.5">
            <span aria-hidden="true" className="size-1.5 animate-pulse-soft rounded-full bg-ok" />
            Live
          </Badge>
        )}
        <Eyebrow>
          Campaign {board.campaign.slice(-6)} · {board.attacks.toLocaleString("en-US")} attacks
        </Eyebrow>
      </div>
      <Board board={board} />
      {list && list.length > 1 ? (
        <nav aria-label="Other campaigns" className="grid gap-2 text-sm">
          <Eyebrow>Other campaigns</Eyebrow>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {list
              .filter((c) => c.id !== board.campaign && c.attacks > 0)
              .map((c) => (
                <li key={c.id}>
                  <Link href={`/scoreboard/?campaign=${c.id}`} className="font-mono underline">
                    {c.id.slice(-6)}
                  </Link>{" "}
                  <span className="text-muted-foreground">{c.attacks} attacks</span>
                </li>
              ))}
          </ul>
        </nav>
      ) : null}
    </div>
  );
}
