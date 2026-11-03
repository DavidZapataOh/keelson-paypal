const sheet = document.getElementById("sheet");
const chips = [...document.querySelectorAll<HTMLButtonElement>(".legend .chip")];

if (sheet && chips.length) {
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const owner = chip.dataset.owner ?? "";
      const next = sheet.dataset.filter === owner ? "" : owner;
      sheet.dataset.filter = next;
      for (const c of chips) c.setAttribute("aria-pressed", String(c.dataset.owner === next));
    });
  }
}
