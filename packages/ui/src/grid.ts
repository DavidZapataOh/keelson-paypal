import { themeQuartz } from "ag-grid-community";
import { brand, fonts, type Mode, themes } from "./tokens.ts";

function params(mode: Mode) {
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
    cellFontFamily: fonts.mono,
    fontSize: 13,
    borderRadius: 6,
    wrapperBorderRadius: 10,
    rowHeight: 40,
    headerHeight: 40,
    headerBackgroundColor: t.muted,
    headerFontWeight: 500,
    oddRowBackgroundColor: t.background,
    chromeBackgroundColor: t.muted,
  } as const;
}

/**
 * AG Grid's Quartz theme in Keelson's tokens: 40 px rows, mono cells, ink accent. Light is the
 * default; `data-ag-theme-mode="dark"` on `<html>` or `<body>`, set alongside `.dark`, switches it.
 */
export const keelsonGridTheme = themeQuartz
  .withParams(params("light"))
  .withParams(params("light"), "light")
  .withParams(params("dark"), "dark");

/** The integrated charts' palette: ink, the field colors and warm gray, five series. */
export function keelsonChartPalette(mode: Mode) {
  const t = themes[mode];
  const fills = [
    t.foreground,
    t["field-verified"],
    t["field-attested"],
    t["field-yours"],
    brand["warm-gray"],
  ];
  return { fills, strokes: fills };
}
