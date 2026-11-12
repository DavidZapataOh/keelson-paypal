import type { Page } from "playwright";

/** What a page shows, as text, and why some of what it shows cannot be read as text. */
export interface Shown {
  text: string;
  unreadable?: string;
}

/**
 * A currency sign before a number written with letters that look like digits: `$1O.OO`, `$l0.00`
 * (Unicode TR39 confusables).
 */
const CONFUSED = /\p{Sc}\s?[\d.,]*(?:\d[OolI]|[OolI][\d.,])[\dOolI.,]*(?!\p{L})/u;
/** Overrides that draw characters in the reverse of their order in the text (Unicode TR9). */
const OVERRIDES = /[‭‮]/u;

/**
 * The text every rendered frame of `page` shows, as the buyer sees it: each frame's `innerText`,
 * then whatever the browser draws as text that `innerText` leaves out, read from the rendered
 * layout and the accessibility tree over the Chrome DevTools Protocol (`DOMSnapshot`,
 * `Accessibility`): generated content (`::before`, `::after`, list markers), shadow trees, open or
 * closed, and the values of form fields. Text drawn where no text is (a canvas), drawn in another
 * order than written (a bidirectional override), or written with letters for digits is unreadable.
 */
export async function shownText(page: Page): Promise<Shown> {
  const frames = await Promise.all(
    page.frames().map((f) =>
      f
        .evaluate(() => {
          // A frame that is not rendered (`display: none`) is not shown: its `innerText` is its source.
          if (!document.body?.checkVisibility())
            return { text: "", canvas: false, override: false };
          const shown = (el: Element) => el.checkVisibility({ opacityProperty: true });
          const canvas = [...document.querySelectorAll("canvas")].some((c) => {
            const r = c.getBoundingClientRect();
            return r.width * r.height >= 200 && shown(c);
          });
          let override = false;
          for (const el of document.body.querySelectorAll("*")) {
            if (
              /override/.test(getComputedStyle(el).unicodeBidi) &&
              /\d/.test(el.textContent ?? "") &&
              shown(el)
            ) {
              override = true;
              break;
            }
          }
          // biome-ignore lint/performance/useDomNodeTextContent: the text as the buyer sees it on the page.
          return { text: document.body.innerText, canvas, override };
        })
        .catch(() => ({ text: "", canvas: false, override: false })),
    ),
  );
  const inner = frames.map((f) => f.text).join("\n");
  if (frames.some((f) => f.canvas)) return { text: inner, unreadable: "it draws on a canvas" };
  if (frames.some((f) => f.override) || OVERRIDES.test(inner)) {
    return { text: inner, unreadable: "it draws digits in reverse order" };
  }
  const drawn = await drawnText(page);
  if (drawn === undefined) return { text: inner, unreadable: "its rendered text cannot be read" };
  const flat = inner.replace(/\s+/g, " ");
  const extra = [...new Set(drawn.map((t) => t.replace(/\s+/g, " ").trim()))].filter(
    (t) => /\d/.test(t) && !flat.includes(t),
  );
  const text = extra.length > 0 ? `${inner}\n${extra.join("\n")}` : inner;
  if (CONFUSED.test(text))
    return { text, unreadable: "it writes an amount with letters for digits" };
  return { text };
}

/** Every text the page's renderer lays out or exposes to assistive technology; undefined if unread. */
async function drawnText(page: Page): Promise<string[] | undefined> {
  const cdp = await page
    .context()
    .newCDPSession(page)
    .catch(() => undefined);
  if (!cdp) return undefined;
  try {
    const [snapshot, ax] = await Promise.all([
      cdp.send("DOMSnapshot.captureSnapshot", { computedStyles: [] }),
      cdp.send("Accessibility.getFullAXTree"),
    ]);
    const laid = snapshot.documents.flatMap((d) =>
      d.layout.text.filter((i) => i >= 0).map((i) => snapshot.strings[i] ?? ""),
    );
    const exposed = ax.nodes.flatMap((n) =>
      n.role?.value === "StaticText" && !n.ignored && typeof n.name?.value === "string"
        ? [n.name.value]
        : [],
    );
    return [...laid, ...exposed];
  } catch {
    return undefined;
  } finally {
    await cdp.detach().catch(() => {});
  }
}
