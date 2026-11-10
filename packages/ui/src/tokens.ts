/** Keelson brand colors. Vermilion marks what Keelson did (countersigned, blocked) and nothing else. */
export const brand = {
  graphite: "#17181b",
  "graphite-2": "#1f2024",
  bone: "#f2f0ea",
  "bone-2": "#e9e6de",
  vermilion: "#ff4b1f",
  "vermilion-deep": "#b82e06",
  "warm-gray": "#8d8a83",
} as const;

export type Mode = "light" | "dark";

/**
 * Theme tokens by mode, named as the CSS variables of `globals.css` (shadcn names plus Keelson's).
 * `field-*` color the liability of a mandate field: verified by Keelson, attested by the agent's
 * operator under bond, or the user's own.
 */
export const themes = {
  light: {
    background: brand.bone,
    foreground: brand.graphite,
    card: brand.bone,
    "card-foreground": brand.graphite,
    popover: brand.bone,
    "popover-foreground": brand.graphite,
    primary: brand.graphite,
    "primary-foreground": brand.bone,
    secondary: brand["bone-2"],
    "secondary-foreground": brand.graphite,
    muted: brand["bone-2"],
    "muted-foreground": "#5f5c56",
    accent: brand["bone-2"],
    "accent-foreground": brand.graphite,
    destructive: brand["vermilion-deep"],
    border: "#d8d4c9",
    input: brand["warm-gray"],
    ring: brand["vermilion-deep"],
    ok: "#26704f",
    warn: "#855a06",
    "field-verified": "#26704f",
    "field-attested": "#855a06",
    "field-yours": "#5f5c56",
  },
  dark: {
    background: brand.graphite,
    foreground: brand.bone,
    card: brand["graphite-2"],
    "card-foreground": brand.bone,
    popover: brand["graphite-2"],
    "popover-foreground": brand.bone,
    primary: brand.bone,
    "primary-foreground": brand.graphite,
    secondary: brand["graphite-2"],
    "secondary-foreground": brand.bone,
    muted: brand["graphite-2"],
    "muted-foreground": "#a8a59e",
    accent: "#2e3036",
    "accent-foreground": brand.bone,
    destructive: brand.vermilion,
    border: "#2e3036",
    input: brand["warm-gray"],
    ring: brand.vermilion,
    ok: "#4fbf8f",
    warn: "#e0a526",
    "field-verified": "#4fbf8f",
    "field-attested": "#e0a526",
    "field-yours": "#a8a59e",
  },
} as const satisfies Record<Mode, Record<string, string>>;

export const fonts = {
  sans: '"Instrument Sans Variable", "Instrument Sans", system-ui, sans-serif',
  mono: '"Geist Mono Variable", "Geist Mono", ui-monospace, monospace',
} as const;

/** Motion, mirrored in `globals.css`. Only opacity and transform animate. */
export const motion = {
  "ease-out": "cubic-bezier(0.16, 1, 0.3, 1)",
  "ease-in": "cubic-bezier(0.7, 0, 0.84, 0)",
  "duration-state": "120ms",
  "duration-reveal": "200ms",
  "duration-exit": "150ms",
} as const;

/** Radii in px: chips, controls, cards and panels, overlays. */
export const radius = { sm: 4, md: 6, lg: 10, xl: 14 } as const;
