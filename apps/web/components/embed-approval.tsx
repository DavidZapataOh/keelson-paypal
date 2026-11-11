"use client";

import {
  passkeyRegistrationOptions,
  prepareSigning,
  rememberPaymentPasskey,
  type Signing,
  signMandate,
} from "@keelson/mandate/browser";
import { Button } from "@keelson/ui/components/button";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Check, ExternalLink, Fingerprint, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { untilIn } from "../lib/connections";
import { deviceId } from "../lib/device";
import {
  APP_ORIGIN,
  approveEmbed,
  claimLink,
  DONE,
  declineEmbed,
  draftEmbed,
  EmbedError,
  type EmbedSigner,
  type EmbedView,
  framePasskeys,
  type HostEvent,
  LINKED,
  openEmbed,
  passkeyOptions,
  post,
  readEmbed,
  savePasskey,
  signIn,
  signInOptions,
  signUrl,
  startLink,
} from "../lib/embed";
import { money } from "../lib/format";
import { asked, type Chosen, Clause, day, Lower, Value } from "./approval";
import { SplitK } from "./brand";
import { MandateVisual } from "./mandate-visual";

/** Below this the request cannot be shown whole, so it is not shown at all. */
const MIN_WIDTH = 320;
const MIN_HEIGHT = 400;
/** The Allow button waits this long, fully visible, before it takes a click. */
const ARM_MS = 900;
const POLL_MS = 2_000;

type Mode = "frame" | "popup";
type Phase =
  | { at: "loading" }
  | { at: "review" }
  /** The passkey prompt that tells who signs is open. */
  | { at: "identifying" }
  /** A Keelson window linked the user, who has no passkey yet: one is created here. */
  | { at: "create"; busy: boolean }
  /** The user is known: the mandate is drafted for the limits chosen and signed here. */
  | { at: "confirm"; signing: boolean }
  /** This browser or page lets no passkey be used here: the Keelson window signs instead. */
  | { at: "elsewhere"; why: string }
  | { at: "waiting"; blocked: boolean; link: boolean }
  | { at: "approved"; mandateId: string }
  | { at: "declined" }
  | { at: "closed"; title: string; line: string }
  | { at: "unsafe"; title: string; line: string };

const SESSION_KEY = (ref: string) => `keelson.embed.${ref}`;

function where(): { ref: string; mode: Mode; done: boolean; token: string | null } {
  const q = new URLSearchParams(location.search);
  const token = new URLSearchParams(location.hash.slice(1)).get("t");
  // The token is spent below; it leaves the address bar and history now.
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  return {
    ref: q.get("r") ?? "",
    // A framed page is always in frame mode, whatever its address says.
    mode: q.get("mode") === "popup" && window.parent === window ? "popup" : "frame",
    done: q.get("step") === "done",
    token,
  };
}

/** The window the host is in: the parent for a frame, the opener for a popup. */
const peerOf = (mode: Mode): Window | null => (mode === "frame" ? window.parent : window.opener);

/**
 * Whether the framing is the one the request was minted for. `ancestorOrigins` (Chromium,
 * WebKit) names the parent; elsewhere `frame-ancestors` already enforced it.
 */
function framedBy(origin: string): boolean {
  if (window.parent === window) return false;
  const ancestors = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
  return !ancestors || ancestors.length === 0 || ancestors[0] === origin;
}

/**
 * Armed once the button and the whole request have been fully visible, unobscured and
 * untransformed (Intersection Observer v2) for `ARM_MS`; any occlusion disarms it. Browsers
 * without v2 only get the geometric check, so the top-level Keelson window stays the real
 * confirmation.
 */
function useArmed(
  targets: React.RefObject<HTMLElement | null>[],
  active: boolean,
  step: string,
): { visible: boolean; armed: boolean } {
  const [visible, setVisible] = useState(false);
  const [armed, setArmed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are stable; each step re-arms
  useEffect(() => {
    setArmed(false);
    setVisible(false);
    const els = targets.map((t) => t.current);
    if (!active || els.some((el) => !el)) return;
    const seen = new Map<Element, boolean>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(timer);
      setArmed(false);
      const shown =
        document.visibilityState === "visible" && els.every((el) => seen.get(el as Element));
      setVisible(shown);
      if (shown) timer = setTimeout(() => setArmed(true), ARM_MS);
    };
    let observer: IntersectionObserver | undefined;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const v2 = entry as IntersectionObserverEntry & { isVisible?: boolean };
            seen.set(entry.target, v2.isVisible ?? entry.intersectionRatio >= 0.99);
          }
          arm();
        },
        { threshold: [0, 0.99, 1], trackVisibility: true, delay: 100 } as IntersectionObserverInit,
      );
      for (const el of els) observer.observe(el as Element);
    } catch {
      // No observer, no arming.
    }
    document.addEventListener("visibilitychange", arm);
    return () => {
      clearTimeout(timer);
      observer?.disconnect();
      document.removeEventListener("visibilitychange", arm);
    };
  }, [active, step]);
  return { visible, armed };
}

function Brand({ host }: { host: string | undefined }) {
  return (
    <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
      <span className="flex items-center gap-2 font-semibold tracking-[-0.01em]">
        <SplitK className="size-5" />
        Keelson
      </span>
      {host ? (
        <span className="truncate font-mono text-[11px] text-muted-foreground" title={host}>
          on {new URL(host).host}
        </span>
      ) : null}
    </header>
  );
}

function Skeleton() {
  return (
    <div aria-hidden="true" className="grid gap-4 p-4">
      <div className="h-7 w-4/5 rounded-lg bg-bone-2 motion-safe:animate-pulse-soft" />
      <div className="h-4 w-1/2 rounded-md bg-bone-2 motion-safe:animate-pulse-soft" />
      <div className="aspect-[1.586/1] w-full rounded-[22px] bg-graphite/90" />
      <div className="grid gap-2">
        <div className="h-12 rounded-xl bg-bone-2 motion-safe:animate-pulse-soft" />
        <div className="h-12 rounded-xl bg-bone-2 motion-safe:animate-pulse-soft" />
      </div>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 px-4 py-6" role="status">
      <h1 className="text-balance font-semibold text-xl tracking-[-0.02em]">{title}</h1>
      <div className="text-pretty text-muted-foreground leading-snug">{children}</div>
    </div>
  );
}

const NO_EVIDENCE = { merchantSignedCheckout: false, zkTlsFields: new Set<never>() };

/** Why a passkey ceremony failed, for the user; `elsewhere` when this frame may not run it. */
function ceremonyError(e: unknown): { elsewhere: boolean; message: string } {
  const name =
    (e as { name?: string; cause?: { name?: string } } | null)?.cause?.name ??
    (e as { name?: string } | null)?.name;
  if (name === "SecurityError" || name === "NotSupportedError") {
    return { elsewhere: true, message: "This page cannot use your passkey here." };
  }
  if (name === "NotAllowedError" || name === "AbortError") {
    return { elsewhere: false, message: "No passkey was used. Nothing was approved." };
  }
  return { elsewhere: false, message: e instanceof Error ? e.message : "Something went wrong." };
}

/**
 * The approval an agent platform embeds. It shows the request and lets the user lower its limits;
 * the user then signs in and signs the mandate with a passkey here, in the frame. The mandate
 * names the platform's page (`embed.top_origin`) and the browser writes it into the assertion
 * as `topOrigin`, which every verifier checks. A user without a passkey signs in once in a
 * Keelson window and creates one here; where the browser or the page lets no passkey be used in a
 * frame, the Keelson window signs instead. The host hears `ready`, `resize`, `approved` (request
 * and mandate ids) and `declined`, posted only to its own origin.
 */
export function EmbedApproval() {
  const [phase, setPhase] = useState<Phase>({ at: "loading" });
  const [view, setView] = useState<EmbedView>();
  const [chosen, setChosen] = useState<Chosen>();
  const [error, setError] = useState<string>();
  const ctx = useRef<{ mode: Mode; ref: string; session?: string; popup?: Window | null }>({
    mode: "frame",
    ref: "",
  });
  const [signer, setSigner] = useState<EmbedSigner | null>(null);
  const [signing, setSigning] = useState<{ for: string; s: Signing; credentialId: string }>();
  // The browser's payment prompt needs the passkey known to this browser as a payment one; once it
  // fails, the next attempt asks for the passkey directly.
  const paymentPrompt = useRef(true);
  const root = useRef<HTMLDivElement>(null);
  const allow = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());

  const tell = useCallback(
    (event: HostEvent) => {
      if (view) post(peerOf(ctx.current.mode), view.origin, event);
    },
    [view],
  );

  const settle = useCallback((v: EmbedView) => {
    setView(v);
    if (v.signer) setSigner(v.signer);
    const { request } = v;
    if (request.state === "APPROVED" && request.mandateId) {
      setPhase({ at: "approved", mandateId: request.mandateId });
    } else if (request.state === "DENIED") {
      setPhase({ at: "declined" });
    } else if (request.state === "EXPIRED") {
      setPhase({
        at: "closed",
        title: "This request expired",
        line: `Requests last 15 minutes. Ask ${request.name} again.`,
      });
    } else return false;
    return true;
  }, []);

  // Open: spend the token for a session, or, back in a popup after the user answered, report it.
  useEffect(() => {
    const at = where();
    ctx.current = { mode: at.mode, ref: at.ref };
    if (at.done && at.mode === "frame") {
      // The frame that opened this window reads the answer itself; this only wakes it.
      window.opener?.postMessage({ type: DONE, ref: at.ref }, location.origin);
      window.close();
      setPhase({ at: "closed", title: "Done", line: "You can close this window." });
      return;
    }
    const stored = at.mode === "popup" ? sessionStorage.getItem(SESSION_KEY(at.ref)) : null;
    const opening = at.token
      ? openEmbed(at.token).then(({ session, embed }) => {
          if (at.mode === "popup") sessionStorage.setItem(SESSION_KEY(at.ref), session);
          return { session, embed };
        })
      : stored
        ? readEmbed(stored).then((embed) => ({ session: stored, embed }))
        : Promise.reject(new EmbedError(401, "no token"));
    opening
      .then(({ session, embed }) => {
        ctx.current.session = session;
        if (embed.ref !== at.ref) throw new EmbedError(401, "ref mismatch");
        if (at.mode === "frame" && !framedBy(embed.origin)) {
          setPhase({
            at: "unsafe",
            title: "Open this from the agent's app",
            line: "This approval is shown only inside the app that asked for it.",
          });
          return;
        }
        if (at.mode === "popup" && !window.opener) {
          setPhase({
            at: "unsafe",
            title: "Open this from the agent's app",
            line: "This window was not opened by the app that asked for it.",
          });
          return;
        }
        setChosen(asked(embed.request));
        if (!settle(embed)) setPhase({ at: "review" });
        post(peerOf(at.mode), embed.origin, { type: "ready", requestId: embed.ref });
      })
      .catch(() => {
        setPhase({
          at: "closed",
          title: "This approval link was already used",
          line: "Ask the app to show the request again.",
        });
      });
  }, [settle]);

  // Size: report the content height so the host never clips or jumps.
  useEffect(() => {
    const el = root.current;
    if (!el || !view || ctx.current.mode !== "frame") return;
    let last = 0;
    const report = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height !== last) tell({ type: "resize", height });
      last = height;
    };
    const ro = new ResizeObserver(report);
    ro.observe(el);
    report();
    return () => ro.disconnect();
  }, [view, tell]);

  // Answers reach the host once, whichever way the user gave them.
  const told = useRef<string>(undefined);
  useEffect(() => {
    if (!view || told.current) return;
    if (phase.at === "approved") {
      told.current = "approved";
      tell({ type: "approved", requestId: view.ref, mandateId: phase.mandateId });
    } else if (phase.at === "declined") {
      told.current = "declined";
      tell({ type: "declined", requestId: view.ref });
    }
    if (told.current && ctx.current.mode === "popup") setTimeout(() => window.close(), 1_200);
  }, [phase, view, tell]);

  // While the Keelson window is open: read the answer, woken early by that window.
  const linking = phase.at === "waiting" && phase.link;
  useEffect(() => {
    if (phase.at !== "waiting") return;
    const { session } = ctx.current;
    if (!session) return;
    let stop = false;
    const check = async () => {
      try {
        const v = await readEmbed(session);
        if (stop) return;
        if (settle(v)) return;
        if (ctx.current.popup?.closed) {
          setPhase({ at: "review" });
          setError("The Keelson window closed before you answered. Nothing was approved.");
        }
      } catch {}
    };
    const t = setInterval(check, POLL_MS);
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ctx.current.popup) return;
      const data = e.data as { type?: string; grant?: unknown } | null;
      if (e.origin === location.origin && data?.type === DONE) void check();
      // Only the window this frame opened, on the app's origin, can hand it the link's grant.
      if (linking && e.origin === APP_ORIGIN && data?.type === LINKED) {
        if (typeof data.grant !== "string") return;
        claimLink(session, data.grant)
          .then((who) => {
            setSigner(who);
            setPhase(
              who.passkeys.length > 0
                ? { at: "confirm", signing: false }
                : { at: "create", busy: false },
            );
          })
          .catch(() => {
            setPhase({ at: "review" });
            setError("Keelson could not link the window. Try again.");
          });
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      stop = true;
      clearInterval(t);
      window.removeEventListener("message", onMessage);
    };
  }, [phase.at, linking, settle]);

  // Once the user is known, the mandate for the chosen limits is drafted, so the prompt opens on
  // the click.
  const chosenKey = JSON.stringify(chosen ?? null);
  useEffect(() => {
    const { session } = ctx.current;
    if (phase.at !== "confirm" || !signer || !chosen || !session) return;
    if (signing?.for === chosenKey) return;
    let stop = false;
    void (async () => {
      try {
        const compiled = await draftEmbed(
          session,
          {
            limits: {
              perPurchaseMinor: chosen.perPurchase,
              totalMinor: chosen.total,
              merchants: chosen.merchants,
              until: chosen.until,
              ...(chosen.askAbove === null ? {} : { askAboveMinor: chosen.askAbove }),
            },
            ...(signer.credentialId ? { credentialId: signer.credentialId } : {}),
          },
          deviceId(),
        );
        const s = await prepareSigning(
          compiled.mandateDraft,
          crypto.getRandomValues(new Uint8Array(16)),
          NO_EVIDENCE,
          compiled.ambiguous,
        );
        if (!stop)
          setSigning({ for: chosenKey, s, credentialId: compiled.mandateDraft.user.cred.id });
      } catch (e) {
        if (stop) return;
        setPhase({ at: "review" });
        setError(e instanceof Error ? e.message : "The mandate could not be drafted. Try again.");
      }
    })();
    return () => {
      stop = true;
    };
  }, [phase.at, signer, chosen, chosenKey, signing?.for]);

  // A passkey is created on the click that asks for it: its options are fetched before.
  const [creation, setCreation] = useState<{
    options: Awaited<ReturnType<typeof passkeyOptions>>;
    platform: boolean;
  }>();
  useEffect(() => {
    const { session } = ctx.current;
    if (phase.at !== "create" || creation || !session) return;
    let stop = false;
    (async () => {
      const platform = (await passkeyRegistrationOptions()).authenticatorAttachment === "platform";
      const options = await passkeyOptions(session, platform);
      if (!stop) setCreation({ options, platform });
    })().catch((e: unknown) => {
      if (!stop) setError(e instanceof Error ? e.message : "Creating a passkey could not start.");
    });
    return () => {
      stop = true;
    };
  }, [phase.at, creation]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const [fits, setFits] = useState(true);
  useEffect(() => {
    if (ctx.current.mode !== "frame") return;
    const check = () => setFits(innerWidth >= MIN_WIDTH && innerHeight >= MIN_HEIGHT);
    check();
    addEventListener("resize", check);
    return () => removeEventListener("resize", check);
  }, []);

  const reviewing =
    (phase.at === "review" || phase.at === "confirm" || phase.at === "create") && fits;
  const summary = useRef<HTMLParagraphElement>(null);
  const { visible, armed } = useArmed([allow, summary], reviewing, phase.at);

  if (phase.at === "loading" || !view || !chosen) {
    if (phase.at === "closed" || phase.at === "unsafe") {
      return (
        <div ref={root} className="bg-background">
          <Brand host={undefined} />
          <Notice title={phase.title}>{phase.line}</Notice>
        </div>
      );
    }
    return (
      <div ref={root} className="bg-background">
        <Brand host={undefined} />
        <Skeleton />
        <p role="status" className="sr-only">
          Loading the request
        </p>
      </div>
    );
  }

  const { request, origin } = view;
  const { currency } = request.limits;
  const requested = asked(request);
  const cap = money(BigInt(chosen.total), currency);
  const merchantNames = request.limits.merchants
    .filter((m) => chosen.merchants.includes(m.id))
    .map((m) => m.name);
  const set = (patch: Partial<Chosen>) => setChosen((c) => (c ? { ...c, ...patch } : c));
  const once = request.kind === "once";

  /** Opens the Keelson app's approval in a top-level window; `link` makes it only sign the user in. */
  const openWindow = (link?: Promise<string>) => {
    const w = 480;
    const h = 760;
    const features = `popup,width=${w},height=${h},left=${Math.round(screenX + (outerWidth - w) / 2)},top=${Math.round(screenY + (outerHeight - h) / 2)}`;
    // An unguessable name, so the host cannot look the window up and navigate it.
    const name = `keelson-${crypto.randomUUID()}`;
    if (!link) {
      const popup = window.open(signUrl(view, ctx.current.mode, chosen), name, features);
      ctx.current.popup = popup;
      setPhase({ at: "waiting", blocked: popup === null, link: false });
      return;
    }
    // Opened on the click, and sent on once the link exists.
    const popup = window.open("about:blank", name, features);
    ctx.current.popup = popup;
    setPhase({ at: "waiting", blocked: popup === null, link: true });
    link
      .then((nonce) => popup?.location.replace(signUrl(view, "frame", chosen, nonce)))
      .catch(() => {
        popup?.close();
        setPhase({ at: "review" });
        setError("The Keelson window could not open. Try again.");
      });
  };

  const approve = async () => {
    if (!armed || chosen.merchants.length === 0) return;
    setError(undefined);
    if (ctx.current.mode === "popup") {
      location.assign(signUrl(view, "popup", chosen));
      return;
    }
    if (!framePasskeys("get")) {
      openWindow();
      return;
    }
    if (signer) {
      setPhase({ at: "confirm", signing: false });
      return;
    }
    const { session } = ctx.current;
    if (!session) return;
    setPhase({ at: "identifying" });
    try {
      const optionsJSON = await signInOptions(session);
      const who = await signIn(session, await startAuthentication({ optionsJSON }));
      setSigner(who);
      setPhase({ at: "confirm", signing: false });
    } catch (e) {
      const { elsewhere, message } = ceremonyError(e);
      if (elsewhere) {
        setPhase({ at: "elsewhere", why: message });
        return;
      }
      setPhase({ at: "review" });
      setError(
        e instanceof EmbedError
          ? message
          : `${message} New to Keelson? Set up your passkey in a Keelson window below.`,
      );
    }
  };

  const sign = async () => {
    const { session } = ctx.current;
    if (!armed || !signing || !signer || !session || phase.at !== "confirm" || phase.signing) {
      return;
    }
    setPhase({ at: "confirm", signing: true });
    setError(undefined);
    const { s, credentialId } = signing;
    try {
      const assertion = await signMandate(
        s.challenge,
        signer.passkeys.filter((p) => p.credentialId === credentialId),
        {
          ...(paymentPrompt.current ? { spc: s.spc } : {}),
          onDevice: signer.credentialId ? [signer.credentialId] : [],
        },
      );
      const created = await approveEmbed(session, {
        payloadSd: s.payloadSd,
        disclosures: s.disclosures,
        commitment: s.commitment,
        salt: s.salt,
        assertion,
        ...(chosen.askAbove === null ? {} : { askAboveMinor: chosen.askAbove }),
      });
      setPhase({ at: "approved", mandateId: created.id });
    } catch (e) {
      const { elsewhere, message } = ceremonyError(e);
      // Each attempt signs a fresh draft.
      setSigning(undefined);
      if (elsewhere) setPhase({ at: "elsewhere", why: message });
      else {
        setPhase({ at: "confirm", signing: false });
        const viaPayment =
          paymentPrompt.current && (e as { name?: string })?.name === "NotAllowedError";
        paymentPrompt.current = false;
        setError(
          viaPayment
            ? "The payment prompt did not finish. Nothing was approved; sign again to use your passkey directly."
            : message,
        );
      }
    }
  };

  const create = async () => {
    const { session } = ctx.current;
    if (!armed || phase.at !== "create" || phase.busy || !creation || !session) return;
    if (!framePasskeys("create")) {
      setPhase({ at: "elsewhere", why: "This page cannot create a passkey here." });
      return;
    }
    setPhase({ at: "create", busy: true });
    setError(undefined);
    try {
      const response = await startRegistration({ optionsJSON: creation.options });
      const who = await savePasskey(session, response);
      if (creation.platform && who.credentialId) rememberPaymentPasskey(who.credentialId);
      setSigner(who);
      setPhase({ at: "confirm", signing: false });
    } catch (e) {
      const { elsewhere, message } = ceremonyError(e);
      // A ceremony's challenge answers once.
      setCreation(undefined);
      if (elsewhere) setPhase({ at: "elsewhere", why: message });
      else {
        setPhase({ at: "create", busy: false });
        setError(message);
      }
    }
  };

  const link = () => {
    const { session } = ctx.current;
    if (!session) return;
    setError(undefined);
    openWindow(startLink(session).then((l) => l.nonce));
  };

  const decline = async () => {
    const { session } = ctx.current;
    if (!session) return;
    setError(undefined);
    try {
      settle(await declineEmbed(session));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Declining failed. Try again.");
    }
  };

  const card = (
    <MandateVisual
      amount={chosen.total / 100}
      currency={currency}
      amountLabel={once ? "This cart" : "Up to"}
      what={once ? "One cart, nothing else" : "Any item at the stores allowed"}
      chips={merchantNames.length ? merchantNames : ["No store"]}
      until={day(chosen.until)}
      state={
        phase.at === "approved" ? "Approved" : phase.at === "declined" ? "Declined" : "Requested"
      }
      seal={phase.at === "approved" ? "closed" : "open"}
    />
  );

  const who = (
    <div className="grid gap-0.5 text-sm">
      <span className="flex items-center gap-1.5 font-medium">
        <ShieldCheck className="size-4 text-ok" aria-hidden="true" />
        {request.agent.operator}
      </span>
      <span className="text-muted-foreground">
        Verified agent platform · registered agent #{request.agent.agentId}
      </span>
    </div>
  );

  if (!fits) {
    return (
      <div ref={root} className="bg-background">
        <Brand host={origin} />
        <Notice title="Not enough room to show this safely">
          Make this panel at least {MIN_WIDTH} by {MIN_HEIGHT} pixels to review {request.name}'s
          request.
        </Notice>
      </div>
    );
  }

  if (phase.at === "unsafe" || phase.at === "closed") {
    return (
      <div ref={root} className="bg-background">
        <Brand host={origin} />
        <Notice title={phase.title}>{phase.line}</Notice>
      </div>
    );
  }

  if (phase.at === "approved" || phase.at === "declined") {
    const approved = phase.at === "approved";
    return (
      <div ref={root} className="grid gap-4 bg-background pb-5">
        <Brand host={origin} />
        <div className="grid gap-4 px-4">
          <h1 className="flex items-center gap-2.5 font-semibold text-2xl tracking-[-0.025em]">
            {approved ? (
              <span className="grid size-7 place-items-center rounded-full bg-ok text-bone motion-safe:animate-reveal">
                <Check className="size-4" strokeWidth={2.5} aria-hidden="true" />
              </span>
            ) : null}
            {approved ? "Approved" : "Declined"}
          </h1>
          <p className="text-pretty leading-snug" role="status">
            {approved
              ? `${request.name} can spend up to ${cap}${merchantNames.length ? ` at ${merchantNames.join(", ")}` : ""} until ${day(chosen.until)}. Revoke it any time in Keelson.`
              : `${request.name} was told no and may not spend. Nothing was signed.`}
          </p>
          {card}
          {who}
        </div>
      </div>
    );
  }

  const armStyle = { "--arm": `${ARM_MS}ms` } as CSSProperties;

  const ready = signing !== undefined && signing.for === chosenKey;
  // The limits are fixed once a draft or the Keelson window has them.
  const locked = phase.at !== "review";
  const armedButton = (label: ReactNode, onClick: () => void, disabled: boolean) => (
    <Button
      ref={allow}
      size="lg"
      onClick={onClick}
      aria-disabled={!armed || disabled}
      data-armed={armed}
      style={armStyle}
      className="relative h-12 overflow-hidden rounded-xl text-[15px] aria-disabled:cursor-not-allowed aria-disabled:bg-graphite-2"
    >
      <span
        aria-hidden="true"
        className="absolute inset-y-0 left-0 w-full origin-left bg-bone/14 motion-reduce:hidden"
        style={{
          transform: `scaleX(${visible ? 1 : 0})`,
          transition: visible ? "transform var(--arm) cubic-bezier(0.4,0,0.2,1)" : "none",
          opacity: armed ? 0 : 1,
        }}
      />
      {label}
    </Button>
  );
  const grant = (
    <p ref={summary} className="text-pretty text-sm leading-snug">
      <span className="font-medium">{request.name}</span> by {request.agent.operator} may spend up
      to <span className="font-medium tnum">{cap}</span>
      {merchantNames.length ? ` at ${merchantNames.join(", ")}` : ""} until {day(chosen.until)}.
    </p>
  );
  const back = (
    <Button
      variant="outline"
      size="lg"
      className="h-12 rounded-xl px-5"
      onClick={() => {
        ctx.current.popup?.close();
        setError(undefined);
        setPhase({ at: "review" });
      }}
    >
      Back
    </Button>
  );
  return (
    <div ref={root} className="grid bg-background">
      <Brand host={origin} />
      <div className="grid gap-4 px-4 pt-4" inert={locked}>
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <span className="inline-flex h-6 items-center rounded-full bg-bone-2 px-2.5">
              Expires in {untilIn(request.expiresAt, now)}
            </span>
          </div>
          <h1 className="text-balance font-semibold text-[1.5rem] leading-[1.12] tracking-[-0.025em]">
            {once
              ? `${request.name} wants ${cap}`
              : `${request.name} wants to spend up to ${money(BigInt(requested.total), currency)}`}
          </h1>
          {who}
        </div>
        {card}
        {once ? null : (
          <figure className="grid gap-1">
            <figcaption className="text-muted-foreground text-xs">
              In {request.name}'s words
            </figcaption>
            <blockquote className="max-h-28 overflow-y-auto rounded-xl bg-bone-2 px-3 py-2.5 font-mono text-[12.5px] leading-relaxed">
              {request.reason}
            </blockquote>
          </figure>
        )}
        <section aria-labelledby="perms">
          <h2 id="perms" className="font-semibold">
            {once ? "What you approve" : "What you allow"}
          </h2>
          <ul className="divide-y">
            {once ? (
              <Clause consequence="block">
                This cart only: <Value>{cap}</Value> at <Value>{merchantNames[0]}</Value>.
              </Clause>
            ) : (
              <>
                <Clause
                  consequence="block"
                  control={
                    <Lower
                      label="Most for one purchase"
                      value={chosen.perPurchase}
                      max={requested.perPurchase}
                      currency={currency}
                      onChange={(v) =>
                        set({
                          perPurchase: v,
                          askAbove: chosen.askAbove === null ? null : Math.min(chosen.askAbove, v),
                        })
                      }
                    />
                  }
                >
                  Up to <Value>{money(BigInt(chosen.perPurchase), currency)}</Value> per purchase
                </Clause>
                <Clause
                  consequence="block"
                  control={
                    <Lower
                      label="Most in total"
                      value={chosen.total}
                      max={requested.total}
                      currency={currency}
                      onChange={(v) =>
                        set({ total: v, perPurchase: Math.min(chosen.perPurchase, v) })
                      }
                    />
                  }
                >
                  <Value>{cap}</Value> in total
                </Clause>
                {chosen.askAbove === null ? null : (
                  <Clause consequence="ask">
                    Asks you first above <Value>{money(BigInt(chosen.askAbove), currency)}</Value>
                  </Clause>
                )}
                <Clause
                  consequence="block"
                  control={
                    request.limits.merchants.length > 1 ? (
                      <fieldset className="flex flex-wrap gap-1.5">
                        <legend className="sr-only">Stores</legend>
                        {request.limits.merchants.map((m) => (
                          <label
                            key={m.id}
                            className="flex h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm has-checked:border-foreground has-focus-visible:outline-2 has-focus-visible:outline-ring"
                          >
                            <input
                              type="checkbox"
                              checked={chosen.merchants.includes(m.id)}
                              onChange={(e) =>
                                set({
                                  merchants: e.target.checked
                                    ? [...chosen.merchants, m.id]
                                    : chosen.merchants.filter((x) => x !== m.id),
                                })
                              }
                              className="size-4 accent-[var(--color-graphite)]"
                            />
                            {m.name}
                          </label>
                        ))}
                      </fieldset>
                    ) : undefined
                  }
                >
                  At {merchantNames.length ? <Value>{merchantNames.join(", ")}</Value> : "no store"}{" "}
                  only
                </Clause>
                <Clause consequence="block">
                  Until <Value>{day(chosen.until)}</Value>
                </Clause>
              </>
            )}
          </ul>
          <p className="text-muted-foreground text-xs">
            You can only lower these. Anything outside them, Keelson refuses before PayPal is
            charged.
          </p>
        </section>
        <p className="flex gap-2 rounded-xl border px-3 py-2.5 text-sm">
          <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {request.agent.bond
              ? `Who answers: ${request.agent.operator} keeps at least ${request.agent.bond.min / 1e6} ${request.agent.bond.asset} on chain for what it vouches for, and PayPal decides disputes.`
              : "Who answers: PayPal decides disputes, with Keelson's record of every check."}
          </span>
        </p>
      </div>

      {/* A frame is as tall as its content, so only the popup's footer needs to stick. */}
      <div
        className={`${ctx.current.mode === "popup" ? "sticky bottom-0" : ""} mt-4 grid gap-2 border-t bg-background px-4 pt-3 pb-4`}
      >
        {error ? (
          <p role="alert" className="text-sm text-vermilion-deep">
            {error}
          </p>
        ) : null}
        {phase.at === "waiting" ? (
          <div className="grid gap-2" role="status">
            <p className="flex items-center gap-2 font-medium">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              {phase.blocked
                ? "Your browser blocked the Keelson window"
                : phase.link
                  ? "Sign in to Keelson in the window, then come back here"
                  : "Confirm in the Keelson window"}
            </p>
            {!phase.link && view.matchNumber !== null ? (
              <p className="text-sm">
                When it asks for your agent's number, pick{" "}
                <span className="rounded-md bg-graphite px-1.5 py-0.5 font-mono font-medium text-bone tnum">
                  {view.matchNumber}
                </span>
                .
              </p>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              {back}
              {phase.blocked ? (
                <Button asChild className="h-11 rounded-xl">
                  <a href={signUrl(view, "frame", chosen)} target="_blank" rel="noreferrer">
                    Open Keelson
                    <ExternalLink aria-hidden="true" />
                  </a>
                </Button>
              ) : (
                <Button className="h-11 rounded-xl" onClick={() => ctx.current.popup?.focus()}>
                  Show the window
                </Button>
              )}
            </div>
          </div>
        ) : phase.at === "elsewhere" ? (
          <div className="grid gap-2">
            <p className="text-pretty text-sm leading-snug" role="status">
              {phase.why} Confirm with your passkey in a Keelson window instead.
            </p>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              {back}
              <Button size="lg" className="h-12 rounded-xl" onClick={() => openWindow()}>
                Continue in Keelson
                <ExternalLink aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : phase.at === "create" ? (
          <div className="grid gap-2">
            {grant}
            <p className="text-pretty text-muted-foreground text-sm leading-snug">
              Create the passkey that signs for you. It stays on this device, and Keelson asks for
              it before anything is approved.
            </p>
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              {back}
              {armedButton(
                <>
                  {phase.busy || !creation ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <KeyRound aria-hidden="true" />
                  )}
                  {phase.busy ? "Waiting for your device" : "Create passkey"}
                </>,
                create,
                !creation || phase.busy,
              )}
            </div>
          </div>
        ) : phase.at === "confirm" ? (
          <>
            {grant}
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              {back}
              {armedButton(
                <>
                  {phase.signing || !ready ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Fingerprint aria-hidden="true" />
                  )}
                  {phase.signing ? "Waiting for your passkey" : `Sign ${cap} with passkey`}
                </>,
                sign,
                !ready || phase.signing,
              )}
            </div>
            <p className="text-center text-muted-foreground text-xs">
              Your passkey signs these limits for {new URL(origin).host}. Keelson checks the
              signature names this page.
            </p>
          </>
        ) : (
          <>
            {/* What Allow grants, beside it: watched with the button, so neither can be covered. */}
            {grant}
            <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
              <Button
                variant="outline"
                size="lg"
                className="h-12 rounded-xl px-5"
                onClick={decline}
                disabled={phase.at === "identifying"}
              >
                {once ? "Decline" : "Reject"}
              </Button>
              {armedButton(
                <>
                  {phase.at === "identifying" ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Fingerprint aria-hidden="true" />
                  )}
                  {phase.at === "identifying"
                    ? "Choose your passkey"
                    : once
                      ? `Approve once · ${cap}`
                      : `Allow ${cap}`}
                </>,
                approve,
                chosen.merchants.length === 0 || phase.at === "identifying",
              )}
            </div>
            {ctx.current.mode === "frame" ? (
              <button
                type="button"
                onClick={link}
                className="justify-self-center text-muted-foreground text-xs underline underline-offset-2 hover:text-foreground"
              >
                New to Keelson? Set up your passkey in a Keelson window
              </button>
            ) : (
              <p className="text-center text-muted-foreground text-xs">
                You confirm with your passkey in Keelson
                {view.matchNumber !== null ? (
                  <>
                    . When it asks for your agent's number, pick{" "}
                    <span className="font-mono font-medium text-foreground tnum">
                      {view.matchNumber}
                    </span>
                  </>
                ) : null}
                .
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
