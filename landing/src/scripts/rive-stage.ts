// Every Rive scene on the page is an artboard of one file, loaded once and
// shared by every canvas. A "stage" is a scene driven by one boolean of its
// view model: it alternates on its own until the visitor picks a side with the
// buttons, pauses off screen, and is skipped entirely with reduced motion (the
// HTML fallback inside the stage stays instead).

import type { Rive as RiveInstance, RiveFile as RiveFileType } from "@rive-app/canvas";

const SRC = "/rive/landing.riv";
const WASM = "/rive/rive.wasm";

let runtime: Promise<{ mod: typeof import("@rive-app/canvas"); file: RiveFileType }> | null = null;

function load() {
  runtime ??= (async () => {
    const mod = await import("@rive-app/canvas");
    mod.RuntimeLoader.setWasmUrl(WASM);
    const file = new mod.RiveFile({ src: SRC });
    await file.init();
    return { mod, file };
  })();
  return runtime;
}

export interface StageOptions {
  stage: HTMLElement;
  canvas: HTMLCanvasElement;
  artboard: string;
  stateMachine: string;
  /** name of the boolean view model property the buttons and the loop drive */
  flag: string;
  /** how long each side plays before the loop flips it (ms) */
  hold: { off: number; on: number };
  /** what a screen reader hears for each side */
  captions?: { off: string; on: string };
  live?: HTMLElement | null;
}

export function mountStage(o: StageOptions) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  start(o).catch(() => {
    // keep the HTML fallback if the runtime cannot load
  });
}

async function start(o: StageOptions) {
  const { mod, file } = await load();
  const buttons = [...o.stage.querySelectorAll<HTMLButtonElement>("[data-value]")];
  let timer = 0;
  let auto = true;
  let on = false;
  let visible = true;

  const rive: RiveInstance = new mod.Rive({
    riveFile: file,
    canvas: o.canvas,
    artboard: o.artboard,
    stateMachine: o.stateMachine,
    autoplay: true,
    autoBind: true,
    layout: new mod.Layout({ fit: mod.Fit.Contain, alignment: mod.Alignment.Center }),
    onLoad: () => {
      rive.resizeDrawingSurfaceToCanvas();
      o.stage.dataset.ready = "true";
      schedule();
    },
  });

  const set = (value: boolean) => {
    on = value;
    const flag = rive.viewModelInstance?.boolean(o.flag);
    if (flag) flag.value = value;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.value === String(value)));
    if (o.live && o.captions) o.live.textContent = value ? o.captions.on : o.captions.off;
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!auto || !visible) return;
    timer = window.setTimeout(
      () => {
        set(!on);
        schedule();
      },
      on ? o.hold.on : o.hold.off,
    );
  };

  for (const b of buttons) {
    b.addEventListener("click", () => {
      auto = false;
      clearTimeout(timer);
      const want = b.dataset.value === "true";
      if (want === on) {
        // replay the same side: step away and back
        set(!want);
        requestAnimationFrame(() => requestAnimationFrame(() => set(want)));
      } else {
        set(want);
      }
    });
  }

  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) {
      rive.play();
      schedule();
    } else {
      rive.pause();
      clearTimeout(timer);
    }
  }).observe(o.stage);

  addEventListener("resize", () => rive.resizeDrawingSurfaceToCanvas());
}
