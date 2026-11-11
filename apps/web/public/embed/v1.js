/**
 * Keelson embed, v1: shows Keelson's approval of an agent's request inside an agent platform.
 *
 *   <script src="https://app.keelson.finance/embed/v1.js"></script>
 *   const approval = Keelson.mount(element, { url, onEvent });  // url from POST /v1/connections/embed
 *   Keelson.popup({ url, onEvent });                            // from a click, when framing is not possible
 *
 * Events: ready, resize (handled here), approved { requestId, mandateId }, declined { requestId },
 * error { code, message }. They are hints for the page: the platform's backend learns the answer
 * from POST /v1/connections/token.
 */
(() => {
  const SOURCE = "keelson";
  const VERSION = 1;
  const MIN_HEIGHT = 480;
  const READY_TIMEOUT_MS = 10_000;

  /** The only origin the approval is served from; a local copy of this script may serve its own. */
  const KEELSON = "https://api.keelson.finance";
  const script = document.currentScript ? new URL(document.currentScript.src) : undefined;
  const local = script && (script.hostname === "localhost" || script.hostname === "127.0.0.1");

  /** The Keelson origin `url` is served from; any other is refused. */
  function originOf(url) {
    const u = new URL(url);
    if (u.origin !== KEELSON && !(local && u.origin === script.origin)) {
      throw new TypeError(`Keelson: the embed URL must be on ${KEELSON}`);
    }
    if (u.pathname !== "/embed/approve" || !u.searchParams.get("r") || !u.hash) {
      throw new TypeError("Keelson: pass the url POST /v1/connections/embed returned");
    }
    return u.origin;
  }

  /** Calls `onEvent` with messages from exactly `peer()` at exactly `origin`. */
  function listen(origin, peer, onEvent) {
    const onMessage = (e) => {
      const from = peer();
      if (!from || e.source !== from || e.origin !== origin) return;
      const d = e.data;
      if (!d || typeof d !== "object" || d.source !== SOURCE || d.version !== VERSION) return;
      if (typeof d.type !== "string") return;
      onEvent(d);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }

  /**
   * Frames the approval in `container`. It grows with its content. The user signs in it with a
   * passkey, so the frame is delegated the passkey features and Secure Payment Confirmation,
   * which shows the amount in the browser's own prompt; the approval's page allows them for itself
   * only. Returns `{ iframe, destroy }`.
   */
  function mount(container, { url, onEvent = () => {} }) {
    const origin = originOf(url);
    const iframe = document.createElement("iframe");
    iframe.title = "Keelson approval";
    iframe.src = url;
    iframe.referrerPolicy = "no-referrer";
    iframe.allow = "publickey-credentials-get; publickey-credentials-create; payment";
    // Scripts and its own origin to call Keelson; popups for the Keelson window, unsandboxed.
    iframe.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox",
    );
    iframe.style.cssText = `display:block;width:100%;min-width:320px;height:${MIN_HEIGHT}px;border:0;color-scheme:normal;transition:height 160ms cubic-bezier(0.2,0,0,1)`;
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) {
        onEvent({ type: "error", code: "frame-timeout", message: "The approval did not load." });
      }
    }, READY_TIMEOUT_MS);
    const stop = listen(
      origin,
      () => iframe.contentWindow,
      (event) => {
        if (event.type === "ready") {
          ready = true;
          clearTimeout(timer);
        }
        if (event.type === "resize" && Number.isFinite(event.height)) {
          iframe.style.height = `${Math.max(MIN_HEIGHT, Math.min(4000, Math.ceil(event.height)))}px`;
        }
        onEvent(event);
      },
    );
    container.appendChild(iframe);
    return {
      iframe,
      destroy() {
        clearTimeout(timer);
        stop();
        iframe.remove();
      },
    };
  }

  /**
   * Opens the approval in a Keelson window: for a browser or a page that cannot frame it. Call it
   * from a click. Returns `{ window, close }`, or null when the browser blocked the window.
   */
  function popup({ url, onEvent = () => {} }) {
    const origin = originOf(url);
    const u = new URL(url);
    u.searchParams.set("mode", "popup");
    const w = 480;
    const h = 760;
    const win = window.open(
      u.toString(),
      `keelson-${u.searchParams.get("r")}`,
      `popup,width=${w},height=${h},left=${Math.round(screenX + (outerWidth - w) / 2)},top=${Math.round(screenY + (outerHeight - h) / 2)}`,
    );
    if (!win) {
      onEvent({ type: "error", code: "popup-blocked", message: "The browser blocked the window." });
      return null;
    }
    let answered = false;
    // The Keelson window answers from the embed page, the same origin as `url`.
    const stop = listen(
      origin,
      () => win,
      (event) => {
        if (event.type === "approved" || event.type === "declined") answered = true;
        onEvent(event);
      },
    );
    const watch = setInterval(() => {
      if (!win.closed) return;
      clearInterval(watch);
      stop();
      if (!answered) onEvent({ type: "error", code: "closed", message: "The window was closed." });
    }, 500);
    return {
      window: win,
      close() {
        clearInterval(watch);
        stop();
        win.close();
      },
    };
  }

  window.Keelson = Object.freeze({ mount, popup, version: VERSION });
})();
