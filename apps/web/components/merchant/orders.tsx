"use client";

import { Amount } from "@keelson/ui/components/amount";
import { BlockDiff } from "@keelson/ui/components/block-diff";
import { Button } from "@keelson/ui/components/button";
import { CopyValue } from "@keelson/ui/components/copy-value";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@keelson/ui/components/sheet";
import { Status } from "@keelson/ui/components/status";
import { ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { VERIFY } from "../../lib/config";
import { major, money, when } from "../../lib/format";
import { type AlibiReceipt, type MerchantOrder, receiptOf } from "../../lib/merchant";
import { Mark, type MarkKind, Panel, Segmented } from "../surface";
import { FIELD, LIABLE } from "./labels";

const FILTERS = ["All", "Bought", "Blocked", "Disputed"] as const;
type Filter = (typeof FILTERS)[number];

/** Purchase states that never reached a capture. */
const OPEN = new Set(["PENDING", "COUNTERSIGNED", "LOGGED", "COVERED"]);

function kindOf(o: MerchantOrder): MarkKind {
  if (o.state === "DENIED") return "blocked";
  if (o.state === "FAILED" || o.dispute) return "attention";
  if (OPEN.has(o.state)) return "checking";
  return "bought";
}

const fieldName = (f: string) =>
  FIELD[f === "total" ? "amount" : f] ??
  f.charAt(0).toUpperCase() + f.slice(1).replaceAll("_", " ");

function line(o: MerchantOrder): string {
  const kind = kindOf(o);
  if (kind === "blocked") {
    const first = o.blocked[0];
    return first ? `Blocked · ${fieldName(first.field)}` : "Blocked";
  }
  if (o.dispute) {
    return o.dispute.liable
      ? `Disputed · ${LIABLE[o.dispute.liable]} liable`
      : `Disputed · ${o.dispute.state.toLowerCase()}`;
  }
  if (o.state === "FAILED") return "Not charged";
  if (kind === "checking") return "Checking";
  return "Bought";
}

const time = (iso: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));

function Row({ o, onOpen }: { o: MerchantOrder; onOpen: () => void }) {
  const kind = kindOf(o);
  const unpaid = kind === "blocked" || o.state === "FAILED";
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3.5 rounded-xl px-2 py-2.5 text-left transition-colors hover:bg-foreground/4"
      >
        <Mark kind={kind} />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate font-medium">Agent #{o.agent_id}</span>
          <span className="truncate text-muted-foreground text-sm">
            {line(o)} · {time(o.created_at)}
          </span>
        </span>
        <span
          className={`font-mono text-[15px] tnum ${unpaid ? "text-muted-foreground line-through decoration-vermilion-deep" : ""}`}
        >
          {money(o.amount_minor, o.currency)}
        </span>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </button>
    </li>
  );
}

/** The sealed record of one order, as the public log publishes it, and the link to verify it. */
function AlibiSheet({ order, onClose }: { order: MerchantOrder | undefined; onClose: () => void }) {
  const [receipt, setReceipt] = useState<AlibiReceipt | "absent">();
  const id = order?.purchase_id;
  const sealed = order?.has_alibi ?? false;
  useEffect(() => {
    setReceipt(undefined);
    if (id && sealed) receiptOf(id).then(setReceipt, () => setReceipt("absent"));
  }, [id, sealed]);
  const blocked = order?.state === "DENIED";

  return (
    <Sheet open={order !== undefined} onOpenChange={(open) => (open ? null : onClose())}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {order ? (
          <>
            <SheetHeader className="gap-3 p-6 pb-0">
              <SheetTitle className="text-lg">Alibi</SheetTitle>
              <SheetDescription>
                Agent #{order.agent_id} · {when(order.created_at)}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-3">
                <Amount
                  value={major(order.amount_minor, order.currency)}
                  currency={order.currency}
                  className="text-[2.25rem]"
                  {...(blocked || order.state === "FAILED" ? { struck: "Not charged" } : {})}
                />
                <Status
                  state={
                    blocked
                      ? "blocked"
                      : order.dispute
                        ? "disputed"
                        : OPEN.has(order.state)
                          ? "checking"
                          : order.state === "FAILED"
                            ? "error"
                            : "captured"
                  }
                />
              </div>
            </SheetHeader>
            <div className="grid gap-5 px-6 pb-6">
              {blocked ? (
                <div className="grid gap-2 rounded-2xl border border-vermilion/35 bg-vermilion/[0.06] p-4">
                  <p className="font-semibold">Keelson stopped this cart. Nothing was charged.</p>
                  {order.blocked.map((b) => (
                    <BlockDiff
                      key={b.field}
                      field={fieldName(b.field)}
                      mandate="private to the buyer"
                      cart={b.cart ?? "not as signed"}
                    />
                  ))}
                </div>
              ) : null}
              {order.dispute ? (
                <DataList layout="stacked">
                  <DataItem label="PayPal dispute">
                    <CopyValue value={order.dispute.dispute_id} label="PayPal dispute id" />
                  </DataItem>
                  <DataItem label="Liable">
                    {order.dispute.liable ? LIABLE[order.dispute.liable] : "Not yet attributed"}
                  </DataItem>
                </DataList>
              ) : null}
              <DataList layout="stacked">
                <DataItem label="Alibi id">
                  <CopyValue value={order.purchase_id} label="Alibi id" />
                </DataItem>
                {receipt && receipt !== "absent" ? (
                  <>
                    <DataItem label="Leaf hash">
                      <CopyValue value={receipt.leaf_hash} label="Leaf hash" />
                    </DataItem>
                    <DataItem label="Timestamps">
                      <span className="font-mono tnum">{receipt.timestamps.length}</span>
                    </DataItem>
                    <DataItem label="Anchored on chain">
                      {receipt.anchor ? "Yes" : "Not yet"}
                    </DataItem>
                  </>
                ) : null}
              </DataList>
              {sealed ? (
                <div className="grid gap-2">
                  <Button asChild>
                    <a href={`${VERIFY}/a/${order.purchase_id}`} target="_blank" rel="noopener">
                      Verify in your browser
                    </a>
                  </Button>
                  <p role="status" className="text-muted-foreground text-xs">
                    {receipt === undefined
                      ? "Reading the public log…"
                      : receipt === "absent"
                        ? "The public log has not published this entry yet."
                        : "Checks the public log entry; it needs no account."}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground text-sm">
                  No Alibi yet: it is sealed once the cart is written to the log.
                </p>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/** Agents' orders at the store: what Keelson let through, what it blocked, what was disputed. */
export function Orders({ orders }: { orders: MerchantOrder[] }) {
  const [filter, setFilter] = useState<Filter>("All");
  const [open, setOpen] = useState<MerchantOrder>();
  const blocked = orders.filter((o) => o.state === "DENIED");
  const disputed = orders.filter((o) => o.dispute);
  const bought = orders.filter((o) => kindOf(o) === "bought");
  const shown =
    filter === "Blocked"
      ? blocked
      : filter === "Disputed"
        ? disputed
        : filter === "Bought"
          ? bought
          : orders;
  const latest = blocked[0];

  return (
    <div className="grid gap-6">
      {latest ? (
        <button
          type="button"
          onClick={() => setOpen(latest)}
          className="flex items-center gap-4 rounded-3xl border border-vermilion/35 bg-vermilion/[0.06] p-4 text-left transition-colors hover:bg-vermilion/10 sm:p-5"
        >
          <Mark kind="blocked" />
          <span className="grid min-w-0 flex-1 leading-snug">
            <span className="font-semibold">
              Keelson blocked {blocked.length} agent {blocked.length === 1 ? "cart" : "carts"}
            </span>
            <span className="truncate text-muted-foreground text-sm">
              Agent #{latest.agent_id} · {money(latest.amount_minor, latest.currency)} ·{" "}
              {line(latest).replace("Blocked · ", "")} · nothing charged
            </span>
          </span>
          <ChevronRight className="size-5 text-muted-foreground" aria-hidden="true" />
        </button>
      ) : null}
      <Panel
        title="Agent orders"
        aside={
          <Segmented
            label="Show"
            options={FILTERS}
            value={filter}
            onChange={setFilter}
            counts={{
              All: orders.length,
              Bought: bought.length,
              Blocked: blocked.length,
              Disputed: disputed.length,
            }}
          />
        }
      >
        {shown.length === 0 ? (
          <p className="py-4 text-muted-foreground text-sm">
            {orders.length === 0
              ? "Orders show up here the moment an agent asks Keelson to countersign a cart."
              : "None in this view."}
          </p>
        ) : (
          <ul className="grid max-h-[480px] overflow-y-auto">
            {shown.map((o) => (
              <Row key={o.purchase_id} o={o} onOpen={() => setOpen(o)} />
            ))}
          </ul>
        )}
      </Panel>
      <AlibiSheet order={open} onClose={() => setOpen(undefined)} />
    </div>
  );
}
