// The hero checkout, drawn in Rive. The HTML card underneath stays visible until
// the animation is ready, and stays instead of it with reduced motion.

const stage = document.getElementById("hero-stage");
const canvas = document.getElementById("hero-rive") as HTMLCanvasElement | null;
const live = document.getElementById("hero-live");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

const CAPTIONS = {
  clean:
    "An agent checks out under a mandate of shoes, size 10, at most 100 dollars. Keelson countersigns the 94 dollar cart and it is paid.",
  attack:
    "A page pushes a 340 dollar bundle and the agent adds it. Keelson finds the total above the 100 dollar mandate and blocks the order. Nothing is paid.",
};

// How long each run plays before the loop flips to the other one (ms)
const HOLD = { clean: 6200, attack: 8200 };

if (stage && canvas && !reduced) {
  start(stage, canvas).catch(() => {
    // keep the HTML card if the runtime cannot load
  });
}

async function start(stage: HTMLElement, canvas: HTMLCanvasElement) {
  const { Rive, RuntimeLoader, Layout, Fit, Alignment } = await import("@rive-app/canvas");
  RuntimeLoader.setWasmUrl("/rive/rive.wasm");

  const buttons = [...stage.querySelectorAll<HTMLButtonElement>(".toggle")];
  let timer = 0;
  let auto = true;
  let attacked = false;

  const rive = new Rive({
    src: "/rive/hero.riv",
    canvas,
    stateMachine: "Checkout",
    autoplay: true,
    autoBind: true,
    layout: new Layout({ fit: Fit.Contain, alignment: Alignment.Center }),
    onLoad: () => {
      rive.resizeDrawingSurfaceToCanvas();
      stage.dataset.ready = "true";
      schedule();
    },
  });

  const set = (value: boolean) => {
    attacked = value;
    const flag = rive.viewModelInstance?.boolean("attacked");
    if (flag) flag.value = value;
    for (const b of buttons) b.setAttribute("aria-pressed", String(b.dataset.attacked === String(value)));
    if (live) live.textContent = value ? CAPTIONS.attack : CAPTIONS.clean;
  };

  const schedule = () => {
    clearTimeout(timer);
    if (!auto) return;
    timer = window.setTimeout(
      () => {
        set(!attacked);
        schedule();
      },
      attacked ? HOLD.attack : HOLD.clean,
    );
  };

  for (const b of buttons) {
    b.addEventListener("click", () => {
      auto = false;
      clearTimeout(timer);
      const want = b.dataset.attacked === "true";
      if (want === attacked) {
        // replay the same run: flip away and back on the next frame
        set(!want);
        requestAnimationFrame(() => requestAnimationFrame(() => set(want)));
      } else {
        set(want);
      }
    });
  }

  new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting) {
      rive.play();
      schedule();
    } else {
      rive.pause();
      clearTimeout(timer);
    }
  }).observe(stage);

  addEventListener("resize", () => rive.resizeDrawingSurfaceToCanvas());
}
