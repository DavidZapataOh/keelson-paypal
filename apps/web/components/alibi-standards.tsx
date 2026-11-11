"use client";

import { decodeSign1, encodeSign1, leafHash, receiptPosition } from "@keelson/scitt";
import { Button } from "@keelson/ui/components/button";
import { DataItem, DataList } from "@keelson/ui/components/data-list";
import { useEffect, useState } from "react";
import { API, VERIFY } from "../lib/config";
import { CHAIN_ID } from "../lib/operator";

/** A v2 Alibi's IETF SCITT transparent statement, as the API serves it. */
export interface Statement {
  bytes: Uint8Array;
  position: { treeSize: bigint; leafIndex: bigint } | null;
  /** The verifier link, carrying the registered statement's leaf hash. */
  verifyUrl: string;
}

const b64url = (b: Uint8Array) =>
  btoa(String.fromCharCode(...b))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

/** The purchase's transparent statement once its Alibi is sealed; `null` for a v1 Alibi. */
export function useStatement(id: string, sealed: boolean): Statement | null {
  const [statement, setStatement] = useState<Statement | null>(null);
  useEffect(() => {
    if (!sealed) return;
    const ctl = new AbortController();
    fetch(`${API}/v1/alibis/${id}.cose`, { signal: ctl.signal })
      .then(async (res) => {
        if (!res.ok) return;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const registered = encodeSign1({ ...decodeSign1(bytes), unprotected: new Map() });
        setStatement({
          bytes,
          position: receiptPosition(bytes),
          verifyUrl: `${VERIFY}/a/${id}#${b64url(leafHash(registered))}.0.${CHAIN_ID}`,
        });
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [id, sealed]);
  return statement;
}

function save(id: string, bytes: Uint8Array) {
  const url = URL.createObjectURL(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/scitt-statement+cose" }),
  );
  const a = Object.assign(document.createElement("a"), { href: url, download: `${id}.cose` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The Alibi as an open standard: what it is, where the log holds it, and the file to hand anyone. */
export function AlibiStandards({ id, statement }: { id: string; statement: Statement }) {
  return (
    <div className="grid gap-3 rounded-2xl border p-4" data-standards>
      <DataList layout="stacked">
        <DataItem label="Format">IETF SCITT transparent statement</DataItem>
        {statement.position ? (
          <DataItem label="Log receipt">
            Entry {statement.position.leafIndex.toString()} of{" "}
            {statement.position.treeSize.toString()}
          </DataItem>
        ) : null}
      </DataList>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={() => save(id, statement.bytes)}>
          Download statement (.cose)
        </Button>
        <Button variant="ghost" asChild>
          <a href={statement.verifyUrl} target="_blank" rel="noopener">
            Verify anywhere
          </a>
        </Button>
      </div>
    </div>
  );
}
