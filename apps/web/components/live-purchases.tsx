"use client";

import { CopyValue } from "@keelson/ui/components/copy-value";
import { Skeleton } from "@keelson/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@keelson/ui/components/table";
import { useEffect, useState } from "react";
import { VERIFY } from "../lib/config";
import { money, when } from "../lib/format";
import { alibiUrl, type LivePurchase, livePurchases } from "../lib/live";
import { ErrorNotice } from "./notice";

export function LivePurchases() {
  const [list, setList] = useState<LivePurchase[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    livePurchases()
      .then(setList)
      .catch(() => setError("The live purchases could not be loaded. Try again in a moment."));
  }, []);

  if (error) return <ErrorNotice>{error}</ErrorNotice>;
  if (!list) return <Skeleton className="h-40 rounded-lg" aria-busy="true" />;
  if (list.length === 0) {
    return <p className="text-muted-foreground">No live purchase has been made yet.</p>;
  }
  return (
    <div className="rounded-lg border bg-card">
      <Table label="Live purchases">
        <caption className="sr-only">
          Each live purchase with its store, amount, PayPal transaction and public Alibi
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Date</TableHead>
            <TableHead scope="col">Store</TableHead>
            <TableHead scope="col" className="text-right">
              Amount
            </TableHead>
            <TableHead scope="col">PayPal transaction</TableHead>
            <TableHead scope="col">Alibi</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="whitespace-nowrap">{when(p.createdAt)}</TableCell>
              <TableCell>
                <a href={p.store} target="_blank" rel="noopener" className="underline">
                  {new URL(p.store).hostname}
                </a>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {money(p.amount.minor, p.amount.currency)}
              </TableCell>
              <TableCell>
                <CopyValue value={p.transactionId} label="PayPal transaction id" />
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <a
                  href={`${VERIFY}/a/${p.id}`}
                  target="_blank"
                  rel="noopener"
                  className="underline"
                >
                  Verify
                </a>
                {" · "}
                <a href={alibiUrl(p.id)} download={`${p.id}.alibi`} className="underline">
                  Download
                </a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
