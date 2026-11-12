import { Bot, Check, Languages, Lock, TriangleAlert } from "lucide-react";
import { confusableWarning } from "../lib/confusable";
import type { ClientIdentity } from "../lib/connections";
import { Chip } from "./approval";

/** A warning that `name` can pass for another one, in a mix of alphabets; nothing otherwise. */
export function ConfusableChip({ name }: { name: string }) {
  const warning = confusableWarning(name);
  if (!warning) return null;
  return (
    <Chip>
      <Languages className="size-3.5 text-warn" aria-hidden="true" />
      <span>
        Looks like “{warning.lookalike}”. This name mixes alphabets. Check it is who you expect.
      </span>
    </Chip>
  );
}

/**
 * Who stands behind an app, as Keelson proved it: the host its metadata document came from, the
 * registered agent that linked it, Keelson's own agent, or nothing at all. `name` is the app's
 * own name, checked for lookalike letters.
 */
export function IdentityRow({
  identity,
  name,
}: {
  identity: ClientIdentity | undefined;
  name: string;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {identity?.kind === "cimd" ? (
        <Chip>
          <Lock className="size-3.5 text-ok" aria-hidden="true" data-testid="identity-lock" />
          <span title={`Keelson fetched this app's identity from ${identity.host} itself.`}>
            Verified <span className="font-mono">{identity.host}</span>
          </span>
        </Chip>
      ) : identity?.kind === "operator" ? (
        <Chip>
          <Check className="size-3.5 text-ok" aria-hidden="true" />
          Registered agent #{identity.agentId} · {identity.operator}
        </Chip>
      ) : identity?.kind === "hosted" ? (
        <Chip>
          <Bot className="size-3.5" aria-hidden="true" />
          Keelson's hosted agent
        </Chip>
      ) : identity?.kind === "unverified" ? (
        <Chip>
          <TriangleAlert className="size-3.5 text-warn" aria-hidden="true" />
          <span title="This app named itself. Keelson could not confirm who runs it.">
            Unverified app
          </span>
        </Chip>
      ) : null}
      <ConfusableChip name={name} />
    </div>
  );
}
