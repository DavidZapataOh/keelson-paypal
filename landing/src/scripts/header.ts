const header = document.getElementById("site-header");

if (header) {
  const HIDE_AFTER = 230;
  let lastY = scrollY;
  let ticking = false;

  const update = () => {
    const y = scrollY;
    header.dataset.scrolled = String(y > 8);
    if (y > HIDE_AFTER && y > lastY + 4) header.dataset.hidden = "true";
    else if (y < lastY - 4 || y <= HIDE_AFTER) header.dataset.hidden = "false";
    lastY = y;
    ticking = false;
  };

  addEventListener(
    "scroll",
    () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    },
    { passive: true },
  );
  header.addEventListener("focusin", () => {
    header.dataset.hidden = "false";
  });
  update();
}
