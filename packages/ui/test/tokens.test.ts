import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { brand, type Mode, themes } from "../src/tokens.ts";

const css = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");

/** The `--name: #hex` declarations of the first rule whose selector is exactly `selector`. */
function declarations(selector: string): Record<string, string> {
  const start = css.indexOf(`\n${selector} {`);
  expect(start, `${selector} block`).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  return Object.fromEntries(
    [...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\s*;/g)].map((m) => [m[1], m[2]]),
  );
}

/** WCAG 2.2 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.2 contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees and HSL saturation. */
function hueSat(hex: string): [number, number] {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return [0, 0];
  const l = (max + min) / 2;
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s];
}

const modes: Mode[] = ["light", "dark"];

describe("globals.css mirrors tokens.ts", () => {
  test("brand colors in @theme", () => {
    const theme = declarations("@theme");
    for (const [name, hex] of Object.entries(brand)) expect(theme[`color-${name}`], name).toBe(hex);
  });

  test.each([
    [":root", "light"],
    [".dark", "dark"],
  ] as const)("%s holds the %s theme", (selector, mode) => {
    expect(declarations(selector)).toEqual(themes[mode]);
  });
});

describe.each(modes)("contrast, %s", (mode) => {
  const t = themes[mode];
  const surfaces = { background: t.background, card: t.card, muted: t.muted } as const;

  // Text on its usual surfaces: WCAG 1.4.3, 4.5:1.
  const text = [
    "foreground",
    "muted-foreground",
    "destructive",
    "ok",
    "warn",
    "field-verified",
    "field-attested",
    "field-yours",
  ] as const;
  test.each(text.flatMap((fg) => Object.keys(surfaces).map((bg) => [fg, bg] as const)))(
    "%s text on %s ≥ 4.5:1",
    (fg, bg) => {
      expect(contrast(t[fg], surfaces[bg as keyof typeof surfaces])).toBeGreaterThanOrEqual(4.5);
    },
  );

  test("text on filled components ≥ 4.5:1", () => {
    expect(contrast(t["primary-foreground"], t.primary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["secondary-foreground"], t.secondary)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["accent-foreground"], t.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(t["popover-foreground"], t.popover)).toBeGreaterThanOrEqual(4.5);
    // Countersigned and Blocked chips: graphite on vermilion.
    expect(contrast(brand.graphite, brand.vermilion)).toBeGreaterThanOrEqual(4.5);
  });

  // Focus ring and field shapes: WCAG 1.4.11, 3:1.
  test.each(["ring", "field-verified", "field-attested", "field-yours"] as const)(
    "%s against every surface ≥ 3:1",
    (mark) => {
      for (const bg of Object.values(surfaces)) {
        expect(contrast(t[mark], bg)).toBeGreaterThanOrEqual(3);
      }
    },
  );

  test("input boundaries ≥ 3:1 where inputs sit", () => {
    expect(contrast(t.input, t.background)).toBeGreaterThanOrEqual(3);
    expect(contrast(t.input, t.card)).toBeGreaterThanOrEqual(3);
  });
});

describe("brand rules", () => {
  test("vermilion is never text on a light surface", () => {
    expect(Object.values(themes.light)).not.toContain(brand.vermilion);
  });

  test("no blue anywhere", () => {
    for (const hex of [
      ...Object.values(brand),
      ...modes.flatMap((m) => Object.values(themes[m])),
    ]) {
      const [h, s] = hueSat(hex);
      expect(h >= 180 && h <= 260 && s > 0.2, hex).toBe(false);
    }
  });

  test("the three field kinds are three different colors in each mode", () => {
    for (const m of modes) {
      const t = themes[m];
      expect(new Set([t["field-verified"], t["field-attested"], t["field-yours"]]).size).toBe(3);
    }
  });
});
