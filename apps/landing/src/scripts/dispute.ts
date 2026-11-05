const stage = document.getElementById("dispute-stage");

if (stage) {
  const buttons = [...stage.querySelectorAll<HTMLButtonElement>(".step")];
  const last = buttons.length;
  let timer = 0;

  const show = (n: number) => {
    stage.dataset.step = String(n);
    buttons.forEach((b, i) => {
      const at = i + 1;
      b.classList.toggle("done", at < n);
      if (at === n) b.setAttribute("aria-current", "step");
      else b.removeAttribute("aria-current");
    });
  };

  const stop = () => {
    clearTimeout(timer);
    timer = 0;
  };

  const play = (from = 1) => {
    stop();
    show(from);
    if (from < last) timer = window.setTimeout(() => play(from + 1), 1400);
  };

  for (const b of buttons) {
    b.addEventListener("click", () => {
      stop();
      show(Number(b.dataset.to));
    });
  }

  if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          io.disconnect();
          play(1);
        }
      },
      { threshold: 0.35 },
    );
    io.observe(stage);
  }
}
