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

| Family    | Tokens                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| Type      | Tailwind's rem scale plus `text-ui` (13 px, console body) and `text-amount` (40 px, tabular, one per screen)          |
| Radius    | `rounded-sm` 4 px chips, `rounded-md` 6 px controls, `rounded-lg` 10 px cards and panels, `rounded-xl` 14 px overlays |
| Elevation | Cards sit on a hairline `border`; only overlays cast `shadow-overlay`                                                 |
| Motion    | `ease-out`, `ease-in`; 120 ms state, 200 ms reveal and overlay in, 150 ms exit; only opacity and transform move       |

Under `prefers-reduced-motion: reduce` nothing moves: every animation and transition is instant.

Vermilion fills only what Keelson did: the `countersigned` and `blocked` states. A system error is
graphite with a Vermilion Deep border and "!". Vermilion is never text on a light surface (2.94:1).
No blue.

## Components

| Component                    | Notes                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Button`, `Badge`, `Card`    | shadcn/ui (new-york). Buttons are 44 px by default, `sm` 32 px and `xs` 28 px for consoles.                                                                                    |
| Forms                        | `Field`, `Input`, `InputGroup`, `Textarea`, `Label`, `Select`, `Checkbox`, `RadioGroup`, `Switch`. Inputs are 44 px.                                                           |
| Overlays                     | `Dialog` for consequential confirmations, `Sheet` for details and editors, and `Toaster` (Sonner, bottom right).                                                               |
| Data and states              | `Table` (40 px rows, tabular numbers), `Tabs` (`default` pill, `line`), `Skeleton`, `Empty`, `Alert` (`attention`, `destructive`), `Separator`.                                |
| `Liability`, `LiabilityMark` | A field's liability as color, shape and label: square with a check, diamond, dotted circle. The mark alone is a named image.                                                   |
| `Status`                     | A purchase's state as text, glyph and tone, from `mandate-signed` to `bond-slashed`, plus `error`. `appearance="inline"` for table cells; `reveal` plays the countersign once. |
| `LiabilityField`             | A mandate field as a row: its name, its value and who answers for it.                                                                                                          |
| `Amount`                     | Money in Geist Mono with tabular figures and a muted currency code; `signed`, true minus, `struck` with its reason.                                                            |
| `DataList`, `DataItem`       | Label and value pairs: `row` for receipts and ledgers, `stacked` for detail rails.                                                                                             |
| `CopyValue`                  | An ID in mono with a copy button; `short` keeps the ends on screen and the full value in the copy.                                                                             |
| `Timeline`, `TimelineItem`   | Who did what and when: `done`, `current`, `upcoming`, `blocked` (Keelson's act, vermilion), `failed` (ink "!").                                                                |
| `Meter`                      | How much of a cap is used, as a bar and in words; warn past 90 %, never vermilion.                                                                                             |
| `BlockDiff`                  | Why a cart was blocked, in one line: the mandate, the cart, the block.                                                                                                         |

An error names the problem, the fix and an example: "Enter an amount above $0.00, for example
100.00." It sits under the field with `FieldError`, never in a native browser bubble.

## AG Studio

```tsx
import { keelsonStudioTheme } from "@keelson/ui/studio";

<AgStudio theme={keelsonStudioTheme} />;
```

`ag-studio` is a peer dependency. Rows are 40 px, grid cells use Geist Mono, selection and focus use the foreground
color, and the chart palette is ink, the three field colors and warm gray.

## Tests

```sh
pnpm --filter @keelson/ui test
```

- Contrast of every token pair (text 4.5:1, focus ring and field shapes 3:1), light and dark.
- axe-core with the WCAG 2.2 A and AA rules on a page with every component, light and dark, in
  Chromium. The same run checks the fonts, the keyboard focus ring and AG Studio's resolved theme.
- Keyboard: dialogs trap and return focus, sheets and dialogs close on Escape, tabs and selects move with the arrow keys; toasts are announced; reduced motion stops every animation.
- Bundle budgets: CSS under 20 KB gzip; core JS without React (Button, Badge, Card, Status, Liability) under 20 KB gzip; every component together under 80 KB gzip.
