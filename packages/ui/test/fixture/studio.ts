import { createStudio } from "ag-studio";
import { keelsonStudioTheme } from "../../src/studio.ts";

createStudio(document.getElementById("studio") as HTMLElement, {
  theme: keelsonStudioTheme,
  mode: "view",
});
