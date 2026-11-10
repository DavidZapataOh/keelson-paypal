import { type AgStudioTheme, type AgStudioThemeParams, studioTheme } from "ag-studio";
import { brand, fonts, type Mode, themes } from "./tokens.ts";

function params(mode: Mode): Partial<AgStudioThemeParams> {
  const t = themes[mode];
  return {
    browserColorScheme: mode,
    backgroundColor: t.background,
    foregroundColor: t.foreground,
    textColor: t.foreground,
    subtleTextColor: t["muted-foreground"],
    // Selection and focus in neutral ink: vermilion is kept for Keelson's own acts.
    accentColor: t.foreground,
    borderColor: t.border,
    invalidColor: t.destructive,
    fontFamily: fonts.sans,
    gridCellFontFamily: fonts.mono,
    chartFontFamily: fonts.sans,
    borderRadius: 6,
    gridRowHeight: 42,
    gridHeaderBackgroundColor: t.muted,
    gridOddRowBackgroundColor: t.background,
    studioCanvasBackgroundColor: t.background,
    studioWidgetBackgroundColor: t.card,
    valueChangeUpColor: t.ok,
    valueChangeDownColor: t.warn,
    chartPaletteFills1Color: t.foreground,
    chartPaletteFills2Color: t["field-verified"],
    chartPaletteFills3Color: t["field-attested"],
    chartPaletteFills4Color: t["field-yours"],
    chartPaletteFills5Color: brand["warm-gray"],
    chartPaletteStrokes1Color: t.foreground,
    chartPaletteStrokes2Color: t["field-verified"],
    chartPaletteStrokes3Color: t["field-attested"],
    chartPaletteStrokes4Color: t["field-yours"],
    chartPaletteStrokes5Color: brand["warm-gray"],
    // AG's default palette continues in blues; the Keelson palette ends at five.
    chartPaletteFills6Color: "transparent",
    chartPaletteFills7Color: "transparent",
    chartPaletteFills8Color: "transparent",
    chartPaletteFills9Color: "transparent",
    chartPaletteFills10Color: "transparent",
    chartPaletteStrokes6Color: "transparent",
    chartPaletteStrokes7Color: "transparent",
    chartPaletteStrokes8Color: "transparent",
    chartPaletteStrokes9Color: "transparent",
    chartPaletteStrokes10Color: "transparent",
  };
}

/**
 * AG Studio's default theme in Keelson's tokens. Light is the default; `data-ag-theme-mode="dark"`
 * on `<html>` or `<body>`, set alongside the `.dark` class, switches to dark.
 */
export const keelsonStudioTheme: AgStudioTheme<AgStudioThemeParams> = studioTheme
  .withParams(params("light"))
  .withParams(params("light"), "light")
  .withParams(params("dark"), "dark");
