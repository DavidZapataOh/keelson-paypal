const hero = document.getElementById("top");
const canvas = document.getElementById("field") as HTMLCanvasElement | null;
const ledger = document.getElementById("ledger");
const keyNote = document.getElementById("key-note");
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

if (hero && canvas && ledger && keyNote && !reduced) {
  const ctx = canvas.getContext("2d");
  if (ctx) start(hero, canvas, ctx, ledger, keyNote);
}

function start(
  hero: HTMLElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  ledger: HTMLElement,
  keyNote: HTMLElement,
) {
  const SX = 26;
  const SY = 22;
  const RIPPLE_MS = 1100;
  const rows = ledger.querySelector<HTMLElement>(".rows") ?? ledger;

  let W = 0;
  let H = 0;
  let dpr = 1;
  let cols = 0;
  let nrows = 0;
  let radius = 270;
  let base: HTMLCanvasElement | null = null;
  let rest = { x: 0, y: 0 };
  let origin = { x: 0, y: 0 };
  const lens = { x: 0, y: 0 };
  const target = { x: 0, y: 0 };
  let lastMove = Number.NEGATIVE_INFINITY;
  let ripples: { x: number; y: number; t: number }[] = [];
  let raf = 0;
  let visible = true;

  const smooth = (a: number, b: number, x: number) => {
    const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return u * u * (3 - 2 * u);
  };
  const tickX = (r: number, c: number) => c * SX + (r % 2 ? SX / 2 : 0);
  const restAlpha = (x: number, y: number) =>
    0.16 + 0.14 * (1 - Math.min(1, Math.hypot(x - W / 2, y - H / 2) / (Math.hypot(W, H) * 0.55)));

  function layout() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    W = hero.clientWidth;
    H = hero.clientHeight;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    cols = Math.ceil(W / SX) + 1;
    nrows = Math.ceil(H / SY) + 1;
    radius = W < 700 ? 170 : 270;

    base = document.createElement("canvas");
    base.width = canvas.width;
    base.height = canvas.height;
    const b = base.getContext("2d");
    if (b) {
      b.scale(dpr, dpr);
      for (let r = 0; r < nrows; r++) {
        for (let c = 0; c < cols; c++) {
          const x = tickX(r, c);
          const y = r * SY;
          b.fillStyle = `rgba(23,24,27,${restAlpha(x, y).toFixed(3)})`;
          b.fillRect(x - 0.6, y - 4.5, 1.2, 9);
        }
      }
    }

    const hb = hero.getBoundingClientRect();
    const rb = rows.getBoundingClientRect();
    const lb = ledger.getBoundingClientRect();
    origin = { x: lb.left - hb.left, y: lb.top - hb.top };
    rest = { x: rb.left - hb.left + rb.width / 2, y: rb.top - hb.top + rb.height / 2 };
    if (!lens.x) {
      lens.x = target.x = rest.x;
      lens.y = target.y = rest.y;
    }
  }

  function drawTick(x: number, y: number, w: number, h: number, a: number) {
    ctx.fillStyle = `rgba(23,24,27,${a.toFixed(3)})`;
    ctx.fillRect(x - w / 2, y - h / 2, w, h);
  }

  function frame(t: number) {
    if (t - lastMove > 2600) {
      target.x = rest.x + 44 * Math.cos(t * 0.00035);
      target.y = rest.y + 34 * Math.sin(t * 0.00052);
    }
    lens.x += (target.x - lens.x) * 0.11;
    lens.y += (target.y - lens.y) * 0.11;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (base) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, canvas.width, canvas.height);
      ctx.arc(lens.x * dpr, lens.y * dpr, radius * dpr, 0, Math.PI * 2);
      ctx.clip("evenodd");
      ctx.drawImage(base, 0, 0);
      ctx.restore();
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const r0 = Math.max(0, Math.floor((lens.y - radius) / SY));
    const r1 = Math.min(nrows - 1, Math.ceil((lens.y + radius) / SY));
    for (let r = r0; r <= r1; r++) {
      const c0 = Math.max(0, Math.floor((lens.x - radius) / SX) - 1);
      const c1 = Math.min(cols - 1, Math.ceil((lens.x + radius) / SX) + 1);
      for (let c = c0; c <= c1; c++) {
        const x = tickX(r, c);
        const y = r * SY;
        const dx = x - lens.x;
        const dy = y - lens.y;
        const d = Math.hypot(dx, dy);
        if (d >= radius) continue;
        const u = d / radius;
        const band = smooth(0.3, 0.6, u) * (1 - smooth(0.8, 1, u));
        const a = (restAlpha(x, y) + 0.45 * band) * smooth(0.12, 0.5, u);
        drawTick(x + (dx / (d || 1)) * (1 - u) * 8, y, 1.2 + 13 * band, 9 - 6 * band, a);
      }
    }

    if (ripples.length) {
      const reach = Math.max(W, H) * 0.6;
      for (const rp of ripples) {
        const age = (t - rp.t) / RIPPLE_MS;
        const rr = age * reach;
        for (let r = 0; r < nrows; r++) {
          const y = r * SY;
          if (Math.abs(y - rp.y) > rr + 70) continue;
          for (let c = 0; c < cols; c++) {
            const x = tickX(r, c);
            const off = Math.abs(Math.hypot(x - rp.x, y - rp.y) - rr);
            if (off < 70) drawTick(x, y, 1.2, 9, (1 - off / 70) * (1 - age) * 0.5);
          }
        }
      }
      ripples = ripples.filter((rp) => t - rp.t < RIPPLE_MS);
    }

    ctx.strokeStyle = "#FF4B1F";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(lens.x, lens.y, radius * 0.3, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#FF4B1F";
    ctx.fillRect(lens.x - 3, lens.y - 3, 6, 6);

    ledger.style.setProperty("--lx", `${lens.x - origin.x}px`);
    ledger.style.setProperty("--ly", `${lens.y - origin.y}px`);
    ledger.style.setProperty("--lr", `${radius}px`);
    keyNote.style.transform = `translate(${lens.x + radius * 0.5}px, ${lens.y + radius * 0.62}px)`;

    raf = visible ? requestAnimationFrame(frame) : 0;
  }

  function play() {
    if (!raf && visible && !document.hidden) raf = requestAnimationFrame(frame);
  }

  document.documentElement.classList.add("js-field");
  layout();
  play();

  const ro = new ResizeObserver(layout);
  ro.observe(hero);
  ro.observe(rows);
  document.fonts.ready.then(layout);

  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) play();
  }).observe(hero);

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      cancelAnimationFrame(raf);
      raf = 0;
    } else play();
  });

  addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const hb = hero.getBoundingClientRect();
    target.x = e.clientX - hb.left;
    target.y = e.clientY - hb.top;
    lastMove = performance.now();
  });

  hero.addEventListener("pointerdown", (e) => {
    const hb = hero.getBoundingClientRect();
    ripples.push({ x: e.clientX - hb.left, y: e.clientY - hb.top, t: performance.now() });
  });
}
