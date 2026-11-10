# @keelson/ui

Keelson's design system: brand tokens, Instrument Sans and Geist Mono, shadcn/ui components on
Tailwind CSS v4, and the AG Studio theme. Apps import the source; their bundler compiles it.

## Use it

```css
/* the app's global stylesheet */
@import "@keelson/ui/globals.css";
```

```tsx
import { Button } from "@keelson/ui/components/button";
import { Liability } from "@keelson/ui/components/liability";
import { Status } from "@keelson/ui/components/status";
```

- **Vite:** `@tailwindcss/vite` and `@vitejs/plugin-react`; nothing else.
- **Next.js:** `transpilePackages: ["@keelson/ui"]` in `next.config.ts` and `@tailwindcss/postcss`.
- **Dark mode:** the `dark` class on `<html>`. In AG Studio, also set `data-ag-theme-mode="dark"`.
- **New shadcn components:** `pnpm dlx shadcn@latest add <name>` from this directory. They land in
  `src/components` and take their colors from the tokens.

## Tokens

`src/tokens.ts` is the source of every color. `src/styles/globals.css` mirrors it as CSS variables
(shadcn's names, plus `ok`, `warn` and the three `field-*` colors) and a test keeps the two equal.

| Token                       | Light                               | Dark                | Use                         |
| --------------------------- | ----------------------------------- | ------------------- | --------------------------- |
| `background` / `foreground` | bone `#f2f0ea` / graphite `#17181b` | graphite / bone     | Page                        |
| `muted-foreground`          | `#5f5c56`                           | `#a8a59e`           | Secondary text              |
| `ring`, `destructive`       | Vermilion Deep `#b82e06`            | Vermilion `#ff4b1f` | Focus, accent text          |
| `field-verified`            | `#26704f`                           | `#4fbf8f`           | Keelson-verified            |
| `field-attested`            | `#855a06`                           | `#e0a526`           | Operator-attested, bonded   |
| `field-yours`               | `#5f5c56`                           | `#a8a59e`           | The user's own, not covered |

Vermilion fills only what Keelson did: the `countersigned` and `blocked` states. A system error is
graphite with a Vermilion Deep border and "!". Vermilion is never text on a light surface (2.94:1).
No blue.

## Components

| Component                    | Notes                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `Button`, `Badge`, `Card`    | shadcn/ui (new-york). Buttons are 44 px tall by default.                                                                     |
| `Liability`, `LiabilityMark` | A field's liability as color, shape and label: square with a check, diamond, dotted circle. The mark alone is a named image. |
| `Status`                     | A purchase's state as text, glyph and tone, from `mandate-signed` to `bond-slashed`, plus `error`.                           |

## AG Studio

```tsx
import { keelsonStudioTheme } from "@keelson/ui/studio";

<AgStudio theme={keelsonStudioTheme} />;
```

`ag-studio` is a peer dependency. Grid cells use Geist Mono, selection and focus use the foreground
color, and the chart palette is ink, the three field colors and warm gray.

## Tests

```sh
pnpm --filter @keelson/ui test
```

- Contrast of every token pair (text 4.5:1, focus ring and field shapes 3:1), light and dark.
- axe-core with the WCAG 2.2 A and AA rules on a page with every component, light and dark, in
  Chromium. The same run checks the fonts, the keyboard focus ring and AG Studio's resolved theme.
- Bundle budgets: CSS under 15 KB gzip, component JS without React under 20 KB gzip.
