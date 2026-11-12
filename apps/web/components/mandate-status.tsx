import type { MandateView } from "../lib/types";

/**
 * The mandate's line in the public status list: anyone holding the open mandate can check it
 * there, without asking Keelson.
 */
export function MandateStatus({ status }: { status: MandateView["status"] }) {
  if (!status) return null;
  return (
    <p className="text-sm" data-status-list={status.revoked ? "revoked" : "valid"}>
      <span
        className={status.revoked ? "font-medium text-vermilion-deep" : "text-muted-foreground"}
      >
        {status.revoked ? "Revoked · listed publicly" : "Active"}
      </span>{" "}
      <a
        href={status.uri}
        target="_blank"
        rel="noopener"
        className="text-muted-foreground underline underline-offset-4 hover:text-foreground"
      >
        status list entry {status.idx}
      </a>
    </p>
  );
}
