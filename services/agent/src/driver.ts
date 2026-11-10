import {
  BetaAbstractBrowserToolset20260801,
  type BetaBrowserNavigateResult,
  type BetaBrowserState,
  type BetaScreenshotResult,
  type BetaToolsetCallContext,
  ToolError,
} from "@anthropic-ai/sdk/helpers/beta/toolsets";
import type {
  BetaBrowserClickTarget,
  BetaBrowserFormInputInput,
  BetaBrowserGetPageTextInput,
  BetaBrowserKeyInput,
  BetaBrowserLeftClickInput,
  BetaBrowserNavigateInput,
  BetaBrowserReadPageInput,
  BetaBrowserScrollInput,
  BetaBrowserScrollToInput,
  BetaBrowserTypeInput,
  BetaBrowserWaitInput,
} from "@anthropic-ai/sdk/resources/beta";
import type { BrowserContext, Locator, Page } from "playwright";
import { isAllowed, urlPolicy, withScheme } from "./policy.ts";

/** The one tab the driver keeps; the tab-management members stay off. */
const TAB_ID = "main";
/** `read_page` output cap, as the toolset reference asks. */
const MAX_READ = 50_000;
const NAVIGATION_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 5_000;
const WHEEL_NOTCH_PX = 100;

/** Playwright's names for the modifier keys Claude writes in a chord. */
const KEYS: Record<string, string> = {
  ctrl: "Control",
  control: "Control",
  cmd: "Meta",
  meta: "Meta",
  super: "Meta",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  enter: "Enter",
  return: "Enter",
  esc: "Escape",
  escape: "Escape",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  pageup: "PageUp",
  pagedown: "PageDown",
  home: "Home",
  end: "End",
};

const chord = (text: string) =>
  text
    .split("+")
    .map((k) => KEYS[k.toLowerCase()] ?? (k.length === 1 ? k : k[0]?.toUpperCase() + k.slice(1)))
    .join("+");

export interface StoreBrowserOptions {
  /** The only hosts the browser may load anything from. */
  hosts: readonly string[];
  /** Transforms every page read before it reaches the model (spotlighting). */
  mark?: (text: string) => string;
}

/**
 * The browser use toolset over one Playwright page: navigation, reading, pointer and keyboard
 * members on a single tab. `javascript_exec`, `file_upload`, the console and network readers and
 * tab management are never offered. Every request the page makes is checked against the same
 * host allowlist as `navigate`.
 */
export class StoreBrowser extends BetaAbstractBrowserToolset20260801 {
  readonly #page: Page;
  readonly #mark: (text: string) => string;
  #refused = 0;
  #dialogs: { kind: string; message: string }[] = [];
  /** Every page read as the model received it, in order. */
  readonly reads: string[] = [];

  private constructor(page: Page, options: StoreBrowserOptions) {
    const self: { driver?: StoreBrowser } = {};
    super({
      urlPolicy: urlPolicy(options.hosts),
      browserState: () => (self.driver as StoreBrowser).#state(),
    });
    self.driver = this;
    this.#page = page;
    this.#mark = options.mark ?? ((text) => text);
  }

  /** Routes the context's requests through the allowlist and returns the driver for `page`. */
  static async attach(
    context: BrowserContext,
    page: Page,
    options: StoreBrowserOptions,
  ): Promise<StoreBrowser> {
    const browser = new StoreBrowser(page, options);
    await context.route("**/*", (route) => {
      const request = route.request();
      if (isAllowed(request.url(), options.hosts)) return route.continue();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        browser.#refused++;
        // A 204 answer cancels the navigation and keeps the page where it was.
        return route.fulfill({ status: 204 });
      }
      return route.abort("blockedbyclient");
    });
    page.on("dialog", (dialog) => {
      browser.#dialogs.push({ kind: dialog.type(), message: dialog.message() });
      dialog.dismiss().catch(() => {});
    });
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    return browser;
  }

  get page(): Page {
    return this.#page;
  }

  async #state(): Promise<BetaBrowserState> {
    const changes: NonNullable<BetaBrowserState["state_changes"]> = [];
    for (; this.#refused > 0; this.#refused--) changes.push({ type: "navigation_refused" });
    for (const d of this.#dialogs.splice(0)) {
      changes.push({ type: "dialog_dismissed", kind: d.kind, message: d.message });
    }
    const title = await this.#page.title().catch(() => "");
    return {
      tabs: [{ tab_id: TAB_ID, title, url: this.#page.url(), active: true }],
      state_changes: changes,
    };
  }

  #read(text: string): string {
    const marked = this.#mark(text);
    this.reads.push(marked);
    return marked;
  }

  #ref(ref: string): Locator {
    const id = /^ref_(e\d+)$/.exec(ref)?.[1];
    if (!id) throw new ToolError(`Error: ${ref} is not a reference this page returned.`);
    return this.#page.locator(`aria-ref=${id}`);
  }

  async #target(target: BetaBrowserClickTarget): Promise<Locator | { x: number; y: number }> {
    if (target.type === "coordinate") return { x: target.x, y: target.y };
    const locator = this.#ref(target.ref);
    if ((await locator.count()) === 0) {
      throw new ToolError(
        `Error: ${target.ref} is stale or not found on the current page. Re-read the page to get fresh references.`,
      );
    }
    return locator;
  }

  protected override async navigate(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserNavigateInput,
  ): Promise<BetaBrowserNavigateResult> {
    const page = this.#page;
    const response =
      input.url === "back"
        ? await page.goBack()
        : input.url === "forward"
          ? await page.goForward()
          : input.url === "reload"
            ? await page.reload()
            : await page.goto(withScheme(input.url)).catch((err: unknown) => {
                throw new ToolError(`Error: the page did not load (${(err as Error).name}).`);
              });
    return {
      url: page.url(),
      title: await page.title(),
      ...(response ? { status: response.status() } : {}),
    };
  }

  protected override async screenshot(): Promise<BetaScreenshotResult> {
    const png = await this.#page.screenshot({ type: "png" });
    return { data: png.toString("base64"), mediaType: "image/png" };
  }

  protected override async read_page(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserReadPageInput,
  ): Promise<string> {
    const root = input.ref ? this.#ref(input.ref) : this.#page.locator("body");
    const snapshot = await root.ariaSnapshot({ mode: "ai", depth: input.depth ?? 15 });
    let text = snapshot.replace(/\[ref=(e\d+)\]/g, "[ref_$1]");
    if (text.length > MAX_READ) {
      text = `${text.slice(0, MAX_READ)}\n(truncated at ${MAX_READ} characters: read a smaller depth or a ref)`;
    }
    return this.#read(text);
  }

  protected override async get_page_text(
    _ctx: BetaToolsetCallContext,
    _input: BetaBrowserGetPageTextInput,
  ): Promise<string> {
    // biome-ignore lint/performance/useDomNodeTextContent: the toolset reads the rendered text, as a person sees it laid out.
    return this.#read(await this.#page.locator("body").innerText());
  }

  protected override async left_click(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserLeftClickInput,
  ): Promise<void> {
    const target = await this.#target(input.target);
    const modifiers = input.modifiers
      ? (chord(input.modifiers).split("+") as ("Alt" | "Control" | "Meta" | "Shift")[])
      : [];
    if ("x" in target) {
      for (const m of modifiers) await this.#page.keyboard.down(m);
      await this.#page.mouse.click(target.x, target.y);
      for (const m of modifiers.reverse()) await this.#page.keyboard.up(m);
    } else {
      await target.click({ modifiers });
    }
  }

  protected override async form_input(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserFormInputInput,
  ): Promise<void> {
    const locator = this.#ref(input.target.ref);
    const kind = await locator.evaluate((el) =>
      el instanceof HTMLSelectElement
        ? "select"
        : el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")
          ? "check"
          : "text",
    );
    if (kind === "check") await locator.setChecked(Boolean(input.value));
    else if (kind === "select") await locator.selectOption(String(input.value));
    else await locator.fill(String(input.value));
  }

  protected override async type_(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserTypeInput,
  ): Promise<void> {
    await this.#page.keyboard.type(input.text);
  }

  protected override async key(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserKeyInput,
  ): Promise<void> {
    for (let i = 0; i < (input.repeat ?? 1); i++) {
      for (const k of input.text.split(" ").filter(Boolean)) {
        await this.#page.keyboard.press(chord(k));
      }
    }
  }

  protected override async scroll(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserScrollInput,
  ): Promise<void> {
    const px = (input.scroll_amount ?? 3) * WHEEL_NOTCH_PX;
    const [dx, dy] = {
      up: [0, -px],
      down: [0, px],
      left: [-px, 0],
      right: [px, 0],
    }[input.scroll_direction] as [number, number];
    await this.#page.mouse.move(input.target.x, input.target.y);
    await this.#page.mouse.wheel(dx, dy);
  }

  protected override async scroll_to(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserScrollToInput,
  ): Promise<void> {
    await this.#ref(input.target.ref).scrollIntoViewIfNeeded();
  }

  protected override async wait(
    _ctx: BetaToolsetCallContext,
    input: BetaBrowserWaitInput,
  ): Promise<void> {
    await this.#page.waitForTimeout(Math.min(Math.max(input.duration, 0), 30) * 1000);
  }
}
