import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  gsap.registerPlugin(ScrollTrigger);
  const EASE = "expo.out";
  const q = <T extends Element>(sel: string, root: ParentNode = document) => [
    ...root.querySelectorAll<T>(sel),
  ];

  for (const msg of q<HTMLElement>(".msg")) {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: msg, start: "top 88%", once: true },
    });
    tl.from(msg.querySelector(".bubble-wrap"), { opacity: 0, y: 18, duration: 0.5, ease: EASE });
    const line = msg.querySelector(".note .line");
    const sq = msg.querySelector(".note .sq");
    if (line) tl.from(line, { scaleX: 0, duration: 0.5, ease: EASE }, 0.15);
    if (sq) tl.from(sq, { scale: 0, duration: 0.3, ease: "back.out(3)" }, 0.3);
    const note = msg.querySelector(".note");
    if (note) tl.from(note, { opacity: 0, duration: 0.4 }, 0.15);
  }

  const exposed = document.querySelector(".exposed");
  if (exposed) {
    gsap
      .timeline({ scrollTrigger: { trigger: exposed, start: "top 92%", once: true } })
      .from(exposed.querySelector(".bracket"), { scaleX: 0, duration: 0.6, ease: EASE })
      .from(exposed, { opacity: 0, duration: 0.4 }, 0);
  }

  const steps = document.getElementById("steps");
  if (steps) {
    const beam = document.getElementById("beam");
    gsap.fromTo(
      beam,
      { "--p": 0 },
      {
        "--p": 1,
        ease: "none",
        scrollTrigger: { trigger: steps, start: "top 70%", end: "bottom 65%", scrub: 0.4 },
      },
    );

    const stepEls = q<HTMLElement>(".step", steps);
    const at = (el: Element) => ({ trigger: el, start: "top 72%", once: true });
    const [s1, s2, s3] = stepEls;
    if (s1) {
      gsap.from(q(".check", s1), {
        strokeDashoffset: 1,
        duration: 0.7,
        ease: "power2.out",
        scrollTrigger: at(s1),
      });
      gsap.from(q(".key", s1), {
        y: -14,
        opacity: 0,
        duration: 0.7,
        stagger: 0.12,
        ease: EASE,
        scrollTrigger: at(s1),
      });
    }
    if (s2) {
      gsap.from(q(".bars rect", s2), {
        scaleX: 0,
        transformOrigin: "left center",
        transformBox: "fill-box",
        duration: 0.6,
        stagger: 0.06,
        ease: EASE,
        scrollTrigger: at(s2),
      });
    }
    if (s3) {
      gsap.from(q(".pane-l", s3), { x: -40, duration: 0.9, ease: EASE, scrollTrigger: at(s3) });
      gsap.from(q(".pane-r", s3), { x: 40, duration: 0.9, ease: EASE, scrollTrigger: at(s3) });
    }
  }

  for (const win of q<HTMLElement>(".win")) {
    const covers = q(".cover", win);
    const idx = q<HTMLElement>(".win").indexOf(win);
    gsap.fromTo(
      covers,
      { scaleX: 1 },
      {
        scaleX: 0,
        duration: 0.7,
        stagger: 0.09,
        delay: idx * 0.12,
        ease: EASE,
        scrollTrigger: { trigger: win, start: "top 75%", once: true },
      },
    );
  }

  const track = document.getElementById("track");
  if (track) {
    const gates = q<HTMLElement>(".gate", track);
    const tl = gsap.timeline({
      defaults: { ease: "none" },
      scrollTrigger: { trigger: track, start: "top 70%", end: "bottom 70%", scrub: 0.4 },
    });
    tl.fromTo("#proof-beam", { "--p": 0 }, { "--p": 1, duration: 1 }, 0);
    gates.forEach((gate, i) => {
      const at = 0.2 + i * 0.26;
      const open = q(".ap", gate);
      if (open.length) tl.to(open, { stroke: "#FF4B1F", duration: 0.06 }, at);
      const face = gate.classList.contains("last") ? gate.querySelector(".face-fill") : null;
      if (face) tl.fromTo(face, { fill: "#F2F0EA" }, { fill: "#FF4B1F", duration: 0.1 }, at);
      const tick = gate.querySelector(".tick");
      if (tick)
        tl.fromTo(tick, { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.1 }, at + 0.06);
    });

    const beam = document.getElementById("proof-beam");
    const threads = q<HTMLElement>(".thread", track);
    let spans: { t0: number; t1: number }[] = [];
    let vertical = false;
    const measure = () => {
      if (!beam) return;
      vertical = matchMedia("(max-width: 820px)").matches;
      const b = beam.getBoundingClientRect();
      spans = threads.map((t) => {
        const r = t.getBoundingClientRect();
        return vertical
          ? { t0: (r.top - b.top) / b.height, t1: (r.bottom - b.top) / b.height }
          : { t0: (r.left - b.left) / b.width, t1: (r.right - b.left) / b.width };
      });
    };
    const sync = () => {
      if (!beam) return;
      const p = Number(gsap.getProperty(beam, "--p"));
      threads.forEach((t, i) => {
        const span = spans[i];
        if (!span) return;
        const v = Math.min(1, Math.max(0, (p - span.t0) / (span.t1 - span.t0)));
        const rest = `${(1 - v) * 100}%`;
        t.style.clipPath = vertical ? `inset(0 0 ${rest} 0)` : `inset(0 ${rest} 0 0)`;
      });
    };
    measure();
    tl.eventCallback("onUpdate", sync);
    sync();
    ScrollTrigger.addEventListener("refresh", () => {
      measure();
      sync();
    });
  }

  const split = document.querySelector(".split");
  if (split) {
    const st = { trigger: split, start: "top 90%", once: true };
    gsap.from(split.querySelector(".l"), { scaleX: 0, duration: 1, ease: EASE, scrollTrigger: st });
    gsap.from(split.querySelector(".r"), { scaleX: 0, duration: 1, ease: EASE, scrollTrigger: st });
  }

  document.fonts.ready.then(() => ScrollTrigger.refresh());
}
