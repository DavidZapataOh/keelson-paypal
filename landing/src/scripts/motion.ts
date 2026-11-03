import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  gsap.registerPlugin(ScrollTrigger);
  const EASE = "expo.out";
  const q = <T extends Element>(sel: string, root: ParentNode = document) => [
    ...root.querySelectorAll<T>(sel),
  ];

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
