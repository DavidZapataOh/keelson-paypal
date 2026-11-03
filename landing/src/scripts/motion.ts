import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  gsap.registerPlugin(ScrollTrigger);
  const EASE = "expo.out";
  const q = <T extends Element>(sel: string, root: ParentNode = document) => [
    ...root.querySelectorAll<T>(sel),
  ];

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

  const sheet = document.getElementById("sheet");
  if (sheet) {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: sheet, start: "top 75%", once: true },
      defaults: { ease: EASE },
    });
    q<HTMLElement>(".row", sheet).forEach((row, i) => {
      const at = i * 0.09;
      tl.fromTo(row.querySelector(".leader i"), { scaleX: 0 }, { scaleX: 1, duration: 0.7 }, at)
        .fromTo(
          row.querySelector(".tag .mark"),
          { scale: 0.4, autoAlpha: 0 },
          { scale: 1, autoAlpha: 1, duration: 0.45 },
          at + 0.25,
        )
        .fromTo(row.querySelector(".pays"), { autoAlpha: 0, x: -8 }, { autoAlpha: 1, x: 0, duration: 0.5 }, at + 0.3);
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
