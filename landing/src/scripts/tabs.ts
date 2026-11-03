const deck = document.getElementById("deck");

if (deck) {
  const tabs = [...deck.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const lang = document.getElementById("lang");
  const copy = document.getElementById("copy");
  const status = document.getElementById("copy-status");

  const select = (tab: HTMLButtonElement, focus = false) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute("aria-controls") ?? "");
      if (panel) panel.hidden = !on;
    }
    if (lang) lang.textContent = tab.dataset.lang ?? "";
    if (focus) tab.focus();
  };

  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      const next =
        e.key === "ArrowRight" || e.key === "ArrowDown"
          ? tabs[(i + 1) % tabs.length]
          : e.key === "ArrowLeft" || e.key === "ArrowUp"
            ? tabs[(i - 1 + tabs.length) % tabs.length]
            : e.key === "Home"
              ? tabs[0]
              : e.key === "End"
                ? tabs[tabs.length - 1]
                : undefined;
      if (next) {
        e.preventDefault();
        select(next, true);
      }
    });
  }

  copy?.addEventListener("click", async () => {
    const active = tabs.find((t) => t.getAttribute("aria-selected") === "true");
    const panel = document.getElementById(active?.getAttribute("aria-controls") ?? "");
    const text = panel?.querySelector("code")?.textContent;
    if (!text || !status) return;
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = "Copied";
    } catch {
      status.textContent = "Copy failed";
    }
    setTimeout(() => {
      status.textContent = "";
    }, 2000);
  });
}
