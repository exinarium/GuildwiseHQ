# Muster design system

Target: `apps/web` (React 19, Vite, Tailwind CSS v4 via `@tailwindcss/vite`, no `tailwind.config.*` file; Tailwind v4 is configured in CSS with `@theme`). Light and dark. All values below were checked with a script; ratios are WCAG 2.x relative-luminance ratios.

Principles:

1. **Calm surface, loud signal.** Neutral cool-slate surfaces; colour is reserved for state (stage, risk, blocked, needs-you). The one decorative colour is the hi-vis lime accent, used on the dark sidebar, the live dot and the logo node, never for body text.
2. **Tokens, not `dark:` classes.** Components use semantic utilities (`bg-surface`, `text-muted`). The values flip with `[data-theme]`. This removes the 145 `dark:` classes in the current code and makes theming one file.
3. **Colour never carries meaning alone.** Every status has a text label or an icon/shape as well.
4. **Touch first, dense on desktop.** 44 px hit areas on coarse pointers, 32 to 36 px controls on desktop.

---

## 1. Colour tokens

### 1.1 Brand

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--brand` | `#3446D9` | `#4C63F0` | Primary button fill, selected tab bar, active checkbox |
| `--brand-hover` | `#2B3BC0` | `#3F55DE` | Hover/pressed fill |
| `--brand-fg` | `#FFFFFF` | `#FFFFFF` | Text on `--brand` |
| `--brand-text` | `#2D3DC4` | `#9DAEFF` | Links, text-only brand buttons |
| `--brand-soft` | `#E8EBFD` | `#1C2250` | Selected row, active chip, info-ish emphasis |
| `--brand-soft-fg` | `#2433A8` | `#BCC7FF` | Text on `--brand-soft` |
| `--accent` | `#D4F24A` | `#D4F24A` | Hi-vis lime. Fills only: logo node, live dot, sidebar active indicator, "new" pip |
| `--accent-fg` | `#0D1220` | `#0D1220` | Text on `--accent` (14.8:1) |
| `--ring` | `#3446D9` | `#9DAEFF` | Focus ring (6.4:1 on canvas, light; 8.4:1 on surface, dark) |

Ink (logo tile, sidebar): `#0D1220`.

### 1.2 Neutrals

| Token (utility) | Light | Dark | Use |
| --- | --- | --- | --- |
| `--canvas` (`bg-canvas`) | `#F5F6F8` | `#0B0E14` | App background behind panels |
| `--surface` (`bg-surface`) | `#FFFFFF` | `#131822` | Cards, panels, inputs, dialogs |
| `--sunken` (`bg-sunken`) | `#EEF0F4` | `#1A2030` | Board columns, table header, code blocks, skeletons |
| `--overlay` | `rgb(13 18 32 / 0.55)` | `rgb(0 0 0 / 0.65)` | Dialog backdrop |
| `--line` (`border-line`) | `#E2E5EA` | `#262D3B` | Decorative dividers and card borders (not a contrast-required boundary) |
| `--control` (`border-control`) | `#838C9F` | `#667189` | Input, select, checkbox borders (3.2:1 / 3.6:1 against surface, meets 1.4.11) |
| `--fg` (`text-fg`) | `#12161F` | `#ECEFF5` | Primary text |
| `--muted` (`text-muted`) | `#4B5365` | `#A9B2C3` | Secondary text |
| `--subtle` (`text-subtle`) | `#5E687A` | `#8590A6` | Captions, timestamps, placeholders |
| `--disabled-fg` | `#98A1B3` | `#5A6479` | Disabled text only (exempt from contrast; always pair with a disabled style, not meaning) |

Text contrast (ratio against each surface):

| Text | Light on canvas / surface / sunken | Dark on canvas / surface / sunken |
| --- | --- | --- |
| `fg` | 16.7 / 18.1 / 15.9 | 16.8 / 15.4 / 14.1 |
| `muted` | 7.1 / 7.7 / 6.8 | 9.1 / 8.3 / 7.6 |
| `subtle` | 5.2 / 5.6 / 4.9 | 6.0 / 5.5 / 5.1 |
| `brand-text` | 7.5 / 8.1 / 7.1 | 9.1 / 8.4 / 7.7 |
| white on `--brand` | 6.9 | white on dark `--brand` 4.8 |

The current app uses `text-zinc-500` for ~170 captions. On `zinc-100` fills that is 4.3:1 (fails AA); `subtle` above does not.

### 1.3 Semantic

Each has a text/icon colour usable on surfaces, a solid fill (buttons, dots), and a soft tint for badges and banners.

| Role | Text on surface (L / D) | Solid fill (L / D) | Soft bg (L / D) | Soft fg (L / D) | Soft contrast (L / D) |
| --- | --- | --- | --- | --- | --- |
| success | `#17724A` 5.9 / `#4FCB8E` 8.7 | `#17724A` / `#2FA56A` | `#E3F4EB` / `#12301F` | `#0F5A38` / `#8FE6BA` | 7.3 / 9.7 |
| warning | `#9A5B00` 5.4 / `#F2B544` 9.7 | `#B45F06` / `#F2B544` (text on dark fill: `#1A1200`) | `#FCEFD2` / `#352708` | `#7A4500` / `#F7CE7A` | 6.9 / 9.7 |
| danger | `#C0262F` 5.9 / `#FF8089` 7.4 | `#C0262F` / `#E5484D` | `#FBE5E7` / `#3A1318` | `#9E1C25` / `#FFB1B7` | 6.6 / 9.5 |
| info | `#0A64B4` 6.0 / `#62B3FF` 8.0 | `#0A64B4` / `#2E8FEA` | `#E1EFFB` / `#0F2A44` | `#084E8C` / `#A5D3FF` | 7.2 / 9.3 |
| neutral | `--muted` | `#5E687A` / `#667189` | `#E9ECF1` / `#242B3B` | `#3B4252` / `#C5CCDA` | 8.5 / 8.8 |
| brand | `--brand-text` | `--brand` | `#E8EBFD` / `#1C2250` | `#2433A8` / `#BCC7FF` | 8.4 / 9.2 |

White text on solid `danger` (light) 5.9:1, on solid `success` (light) 5.9:1. Solid fills in dark mode (`#E5484D`, `#2FA56A`) are for dots/bars; for dark-mode destructive buttons use `#E5484D` with white text only at 18px+ bold, otherwise use the soft style. Simplest rule for the builder: **in dark mode the danger button is `bg-danger-soft text-danger-soft-fg` with a `border-danger`**; in light mode solid.

### 1.4 Stage and column colours

The board columns come from `packages/shared/src/cards/columns.ts`: Spec, To do, Rework, In progress, Blocked, Review, Test, Docs, Finalize, Done, plus "Test (waiting on bug)". Other workflows (research, feed, custom) bring their own column names, so the mapping must have a **fallback**: unknown column names use `stage-neutral` and a hue from a stable hash of the name over the 8-hue cycle in 1.5.

| Column | Light dot/rail | Dark dot/rail | Glyph (shape, for non-colour cue) | Light contrast on white | Dark contrast on surface |
| --- | --- | --- | --- | --- | --- |
| Spec | `#7C3AED` | `#A78BFA` | pencil | 5.7 | 6.5 |
| To do | `#64748B` | `#94A3B8` | circle outline | 4.8 | 6.9 |
| Rework | `#C2410C` | `#FB923C` | circular arrow | 5.2 | 7.9 |
| In progress | `#2563EB` | `#60A5FA` | half-filled circle | 5.2 | 7.0 |
| Blocked | `#D92D3A` | `#FF7A85` | octagon / stop | 4.8 | 7.1 |
| Review | `#A16207` | `#EAB308` | eye | 4.9 | 9.3 |
| Test | `#0F766E` | `#2DD4BF` | flask / check-square | 5.5 | 9.6 |
| Test (waiting on bug) | `#B45309` dashed rail | `#FBBF24` dashed rail | hourglass | 5.0 | 10.7 |
| Docs | `#BE185D` | `#F472B6` | file-text | 6.0 | 6.7 |
| Finalize | `#4D7C0F` | `#A3E635` | flag | 5.0 | 11.8 |
| Done | `#15803D` | `#4ADE80` | check-circle | 5.0 | 10.2 |

All pass 3:1 for graphical objects. Stage colour is used for: the 3 px top rail of the column, the 8 px dot in the column header, the stage stepper on the card page, and the small stage chip on cards outside the board (desk, search). Header text stays `fg`. Never use the stage colour as text colour.

### 1.5 Fallback hue cycle (custom stages)

`#7C3AED, #2563EB, #0F766E, #BE185D, #4D7C0F, #A16207, #C2410C, #64748B` (light) with the dark counterparts from the table above. Stable hash: sum of char codes mod 8.

### 1.6 Risk and priority

| Token | Meaning | Style |
| --- | --- | --- |
| risk `small` | Default, quiet | neutral soft badge, text "Small risk" only on card page; on the board show nothing for small |
| risk `medium` | | info soft badge with `triangle` glyph |
| risk `large` | Needs two reviewer approvals | warning soft badge with `triangle-alert` glyph, text "Large" |
| risk `architectural` / any higher tier | | danger soft badge with `octagon-alert` glyph |
| priority 1 (or lowest number = highest) | Urgent | danger soft "Urgent" with `chevrons-up` glyph; also pins to top of lists |
| priority 2 (default) | Normal | not shown on tiles, shown as text in details |
| priority 3+ | Low | subtle text + `chevron-down` glyph |
| desk `urgent` | Pinned, needs you first | danger left rail 3 px + "Urgent" badge |
| desk `blocking` | A card is waiting | warning left rail + "Blocking" badge |
| desk `notice` / non-blocking | FYI | neutral rail |

The builder must read the actual `priority` and `riskTier` value sets in `packages/shared` before wiring the map (the UI today only displays `riskTier` as a raw string and `priority` as a number). Unknown values fall back to the neutral badge showing the raw value.

### 1.7 Sidebar (dark in both themes)

| Token | Light theme | Dark theme |
| --- | --- | --- |
| `--side-bg` | `#0D1220` | `#080B12` |
| `--side-border` | `rgb(255 255 255 / 0.08)` | `rgb(255 255 255 / 0.07)` |
| `--side-fg` (items) | `#B4BDD0` (9.9:1) | same |
| `--side-fg-strong` (active, brand) | `#FFFFFF` (18.7:1) | same |
| `--side-label` (group labels) | `#8D98B0` (6.5:1) | same |
| `--side-hover` | `rgb(255 255 255 / 0.06)` | same |
| `--side-active` | `#1E2740` | `#171F36` |
| active indicator | 3 px `--accent` bar at the left edge | same |

An always-dark sidebar is the main identity device: it carries the logo, the lime accent and the desk badge, and it separates "navigation" from "work" without borders.

### 1.8 CSS to put in `apps/web/src/index.css`

```css
@import "tailwindcss";

/* dark: variant follows the data attribute (set by /theme-init.js), not only the OS */
@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));

:root {
  color-scheme: light;
  --canvas:#F5F6F8; --surface:#FFFFFF; --sunken:#EEF0F4; --overlay:rgb(13 18 32 / .55);
  --line:#E2E5EA; --control:#838C9F;
  --fg:#12161F; --muted:#4B5365; --subtle:#5E687A; --disabled-fg:#98A1B3;
  --brand:#3446D9; --brand-hover:#2B3BC0; --brand-fg:#FFFFFF; --brand-text:#2D3DC4;
  --brand-soft:#E8EBFD; --brand-soft-fg:#2433A8; --accent:#D4F24A; --accent-fg:#0D1220; --ring:#3446D9;
  --success:#17724A; --success-fill:#17724A; --success-soft:#E3F4EB; --success-soft-fg:#0F5A38;
  --warning:#9A5B00; --warning-fill:#B45F06; --warning-soft:#FCEFD2; --warning-soft-fg:#7A4500;
  --danger:#C0262F;  --danger-fill:#C0262F;  --danger-soft:#FBE5E7;  --danger-soft-fg:#9E1C25;
  --info:#0A64B4;    --info-fill:#0A64B4;    --info-soft:#E1EFFB;    --info-soft-fg:#084E8C;
  --neutral-soft:#E9ECF1; --neutral-soft-fg:#3B4252;
  --stage-spec:#7C3AED; --stage-todo:#64748B; --stage-rework:#C2410C; --stage-progress:#2563EB;
  --stage-blocked:#D92D3A; --stage-review:#A16207; --stage-test:#0F766E; --stage-waiting:#B45309;
  --stage-docs:#BE185D; --stage-finalize:#4D7C0F; --stage-done:#15803D;
  --side-bg:#0D1220; --side-border:rgb(255 255 255 / .08); --side-fg:#B4BDD0; --side-fg-strong:#FFFFFF;
  --side-label:#8D98B0; --side-hover:rgb(255 255 255 / .06); --side-active:#1E2740;
  --shadow-sm:0 1px 2px rgb(16 24 40 / .06);
  --shadow-md:0 4px 12px rgb(16 24 40 / .08), 0 1px 3px rgb(16 24 40 / .06);
  --shadow-lg:0 16px 40px rgb(16 24 40 / .18), 0 2px 6px rgb(16 24 40 / .08);
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --canvas:#0B0E14; --surface:#131822; --sunken:#1A2030; --overlay:rgb(0 0 0 / .65);
  --line:#262D3B; --control:#667189;
  --fg:#ECEFF5; --muted:#A9B2C3; --subtle:#8590A6; --disabled-fg:#5A6479;
  --brand:#4C63F0; --brand-hover:#3F55DE; --brand-text:#9DAEFF;
  --brand-soft:#1C2250; --brand-soft-fg:#BCC7FF; --ring:#9DAEFF;
  --success:#4FCB8E; --success-fill:#2FA56A; --success-soft:#12301F; --success-soft-fg:#8FE6BA;
  --warning:#F2B544; --warning-fill:#F2B544; --warning-soft:#352708; --warning-soft-fg:#F7CE7A;
  --danger:#FF8089;  --danger-fill:#E5484D;  --danger-soft:#3A1318;  --danger-soft-fg:#FFB1B7;
  --info:#62B3FF;    --info-fill:#2E8FEA;    --info-soft:#0F2A44;    --info-soft-fg:#A5D3FF;
  --neutral-soft:#242B3B; --neutral-soft-fg:#C5CCDA;
  --stage-spec:#A78BFA; --stage-todo:#94A3B8; --stage-rework:#FB923C; --stage-progress:#60A5FA;
  --stage-blocked:#FF7A85; --stage-review:#EAB308; --stage-test:#2DD4BF; --stage-waiting:#FBBF24;
  --stage-docs:#F472B6; --stage-finalize:#A3E635; --stage-done:#4ADE80;
  --side-bg:#080B12; --side-border:rgb(255 255 255 / .07); --side-active:#171F36;
  --shadow-sm:0 0 0 1px rgb(255 255 255 / .04);
  --shadow-md:0 6px 16px rgb(0 0 0 / .45), 0 0 0 1px rgb(255 255 255 / .05);
  --shadow-lg:0 20px 48px rgb(0 0 0 / .6), 0 0 0 1px rgb(255 255 255 / .06);
}
/* Follow the OS until the user picks a theme (theme-init.js sets data-theme either way; this is the no-JS fallback) */
@media (prefers-color-scheme: dark) { :root:not([data-theme]) { /* repeat the dark block */ } }

@theme inline {
  --font-sans: "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-mono: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;

  --color-canvas: var(--canvas);  --color-surface: var(--surface);  --color-sunken: var(--sunken);
  --color-line: var(--line);      --color-control: var(--control);
  --color-fg: var(--fg);          --color-muted: var(--muted);      --color-subtle: var(--subtle);
  --color-brand: var(--brand);    --color-brand-hover: var(--brand-hover);  --color-brand-fg: var(--brand-fg);
  --color-brand-text: var(--brand-text); --color-brand-soft: var(--brand-soft); --color-brand-soft-fg: var(--brand-soft-fg);
  --color-accent: var(--accent);  --color-accent-fg: var(--accent-fg);  --color-ring: var(--ring);
  --color-success: var(--success); --color-success-fill: var(--success-fill);
  --color-success-soft: var(--success-soft); --color-success-soft-fg: var(--success-soft-fg);
  /* repeat for warning, danger, info; plus neutral-soft(-fg) */
  --color-stage-spec: var(--stage-spec); /* ...one per stage token above */
  --color-side: var(--side-bg); --color-side-fg: var(--side-fg); --color-side-strong: var(--side-fg-strong);
  --color-side-label: var(--side-label); --color-side-hover: var(--side-hover); --color-side-active: var(--side-active);
  --color-side-line: var(--side-border);

  --radius-control: 0.5rem;   /* 8  inputs, buttons */
  --radius-card: 0.75rem;     /* 12 panels, tiles */
  --radius-dialog: 1rem;      /* 16 dialogs, sheets */
  --shadow-sm: var(--shadow-sm); --shadow-md: var(--shadow-md); --shadow-lg: var(--shadow-lg);

  --text-xs: 0.75rem;  --text-xs--line-height: 1rem;      /* 12/16 captions, badges */
  --text-sm: 0.8125rem; --text-sm--line-height: 1.125rem; /* 13/18 dense UI, table cells, labels */
  --text-base: 0.875rem; --text-base--line-height: 1.25rem; /* 14/20 body */
  --text-lg: 1rem;     --text-lg--line-height: 1.5rem;    /* 16/24 lead, card titles */
  --text-xl: 1.125rem; --text-xl--line-height: 1.625rem;  /* 18/26 section headings */
  --text-2xl: 1.375rem; --text-2xl--line-height: 1.75rem; /* 22/28 page title */
  --text-3xl: 1.75rem; --text-3xl--line-height: 2.125rem; /* 28/34 login, empty-state hero */

  --ease-out: cubic-bezier(.2, 0, 0, 1);
  --animate-shimmer: shimmer 1.4s linear infinite;
  @keyframes shimmer { to { background-position: -200% 0; } }
}

html { font-family: var(--font-sans); }
body { background: var(--canvas); color: var(--fg); -webkit-font-smoothing: antialiased; font-size: 0.875rem; line-height: 1.25rem; }
h1,h2,h3 { text-wrap: balance; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 4px; }
::selection { background: var(--brand-soft); color: var(--brand-soft-fg); }
@media (prefers-reduced-motion: reduce) { *, ::before, ::after { animation-duration: .01ms !important; transition-duration: .01ms !important; scroll-behavior: auto !important; } }
@media (pointer: coarse) { input, select, textarea { font-size: 16px; } } /* stops iOS zoom on focus */
```

Notes for the builder:

- Tailwind v4 `@theme inline` makes `bg-surface`, `text-muted`, `border-line`, `ring-ring`, `bg-stage-spec/15` (opacity modifiers work on `var()` colours with `color-mix`) available.
- `/theme-init.js` goes in `apps/web/public/` and is loaded with `<script src="/theme-init.js"></script>` in `index.html` `<head>`. **Inline scripts are blocked by the server CSP** (`script-src 'self'`, see `apps/server/src/app.ts`), so it must be an external file. It reads `localStorage['muster-theme']` (`light` | `dark` | absent=system), else `matchMedia('(prefers-color-scheme: dark)')`, and sets `document.documentElement.dataset.theme`. Wrap storage access in try/catch.
- CSP also has `font-src 'self'` and `img-src 'self' data:`. **Google Fonts cannot be used.** Self-host Geist with `pnpm --filter @aom/web add @fontsource-variable/geist @fontsource-variable/geist-mono` and import `@fontsource-variable/geist/wght.css` in `main.tsx`; Vite emits same-origin woff2. This also suits a LAN-hosted site that may be offline. If the owner rejects new dependencies, the system stack is the fallback and the design still works (Geist is metrics-close to system UI fonts).

---

## 2. Typography

| Style | Size / line | Weight | Tracking | Use |
| --- | --- | --- | --- | --- |
| Display | 28 / 34 (`text-3xl`) | 600 | -0.02em | Login headline, empty-state hero |
| Page title | 22 / 28 (`text-2xl`) | 600 | -0.015em | One per page, `h1` |
| Section | 18 / 26 (`text-xl`) | 600 | -0.01em | Panel and tab section headings, `h2` |
| Card title | 16 / 24 (`text-lg`) | 600 | 0 | Desk question, card title on detail, dialog title |
| Body | 14 / 20 (`text-base`) | 400 | 0 | Default |
| UI small | 13 / 18 (`text-sm`) | 500 for labels, 400 for cells | 0 | Field labels, table cells, button text, nav items |
| Caption | 12 / 16 (`text-xs`) | 400 or 500 | 0 | Timestamps, hints, badges (never smaller than 12; the current 11 px badges go) |
| Mono | 12.5 / 18 | 450 | 0 | Card refs (`WEB-42`), branches, commands, pairing code |

Rules: `tabular-nums` on every number that changes (counts, ages, durations, ratios). Card refs are mono. Page title is `text-fg`; subtitle `text-muted` 14/20. Long titles **wrap** (max 3 lines) on the card page; no `truncate` on `h1` (the current `PageHeader` truncates card titles).

Minimum body text 14 px. Inputs 16 px on touch (see CSS).

---

## 3. Spacing, radius, elevation, motion

- **Spacing** 4 px base. Scale used: 4, 8, 12, 16, 20, 24, 32, 48. Page padding: 16 (<640), 24 (640 to 1023), 32 (>=1024). Gap between panels 16, inside panel 16 (12 when `compact`). Form field gap 16, label to control 6.
- **Content widths** (container `mx-auto w-full`): `narrow` 640 (forms: card new, intake start), `default` 960 (lists: ledger, vaults, workstations, projects, admin, desk), `wide` 1200 (agents, org designer, card detail, metrics), `full` (board, no max). Replace the ad hoc `max-w-3xl/4xl/5xl/6xl` with these four.
- **Radius**: 8 controls and badges' square variant, 12 cards/panels/tiles, 16 dialogs and sheets (top corners on mobile), full for pills, avatars, dots.
- **Elevation**: panels have a 1 px `--line` border and no shadow (`shadow-sm` token is nearly invisible); hover on interactive cards adds `shadow-md`; menus/popovers `shadow-md`; dialogs/drawer `shadow-lg`. In dark mode shadows become 1 px light borders (tokens above).
- **Focus**: global `:focus-visible` 2 px `--ring`, 2 px offset. On the dark sidebar use `outline-color: var(--accent)`. Inputs additionally get `ring-2 ring-ring/25` (a soft halo) when focused. Never `outline: none` without a replacement.
- **Motion**: durations 120 ms (hover, press), 200 ms (sidebar width, drawer, dialog, accordion), 300 ms max. Easing `--ease-out`. Dialog: fade + 4 px rise (desktop), slide up (mobile sheet). Drawer: translateX with 200 ms. Skeleton shimmer 1.4 s. Everything is disabled by the reduced-motion rule above. No motion conveys state alone.
- **Z-index**: sidebar 30, top bar 20, sticky page bars 10, drawer backdrop 40, drawer 50, dialog backdrop 60, dialog 70, toast 80, command palette 90.

---

## 4. Components

Existing primitives live in `apps/web/src/components/ui.tsx` and keep their names and props (tests import `Dialog`, `Button` etc. only indirectly, through pages). New ones are added next to them, ideally split into `components/ui/*.tsx` re-exported from `ui.tsx` so imports do not change.

### 4.1 Button

| Variant | Light classes | Notes |
| --- | --- | --- |
| `primary` | `bg-brand text-brand-fg hover:bg-brand-hover` | One per view region |
| `secondary` | `border border-control bg-surface text-fg hover:bg-sunken` | Default |
| `ghost` | `text-muted hover:bg-sunken hover:text-fg` | Toolbar, row actions |
| `danger` | light: `bg-danger-fill text-white hover:brightness-95`; dark: `bg-danger-soft text-danger-soft-fg border border-danger-fill/60` | Destructive confirm only |
| `danger-ghost` | `text-danger hover:bg-danger-soft` | Entry point to a destructive flow (Fire, Unlink, Revoke); the confirm dialog holds the solid `danger` |
| `link` | `text-brand-text underline-offset-2 hover:underline` | Inline text actions |

Sizes: `sm` 32 px (`h-8 px-3 text-sm`), `md` 40 px (`h-10 px-4 text-sm`, **default on touch**), `lg` 44 px. On `@media (pointer: coarse)` every size is at least 44 px tall via `min-h-11`. Radius `rounded-control`. Icon + label gap 8. Icon-only buttons are 40 x 40 (44 on touch) and **must** have `aria-label`.

States: hover (fill step), active (`translate-y-px`, no shadow), disabled (`opacity-50 cursor-not-allowed`, not `pointer-events-none` so tooltips explaining why still work), **loading** (new `loading` prop: inline 16 px spinner replaces the leading icon, `aria-busy="true"`, `disabled`, label unchanged so the width does not jump and the accessible name stays the same for tests).

Labels use sentence case verbs: "Hire agent", "Save changes". Keep every current label (tests query them by name; see implementation plan section 6).

### 4.2 Inputs

Shared field anatomy (the existing `Field` wrapper stays): label (13/500 `text-fg`) above, control, hint (12 `text-subtle`) or error below. Required fields get a visible "(required)" suffix in `text-subtle`, not a red asterisk.

- Control: `h-10 w-full rounded-control border border-control bg-surface px-3 text-base text-fg placeholder:text-subtle focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-ring/25 disabled:bg-sunken disabled:text-disabled-fg` (dense variant `h-9`).
- Error: `border-danger` + 16 px alert icon + message `text-danger` 13/500 with `role="alert"` and `aria-describedby` (as today). On submit with errors, focus moves to the first invalid control (CardNew already does this; make it the shared behaviour).
- **Select**: keep the native `<select>` (best on mobile and for tests) but `appearance-none` with a chevron background and `pr-9`. Searchable combobox only for the project switcher.
- **Textarea**: min 3 rows, `resize-y`, same chrome, optional character count `text-xs text-subtle` right aligned.
- **Checkbox / radio / switch**: `accent-color: var(--brand)` plus 20 px box (24 px hit area via label padding). Option lists in the desk use **choice cards**: full-width label `rounded-card border border-control p-3`, selected `border-brand bg-brand-soft`, with a radio at the left; the "Recommended" badge sits at the right.
- **Password field**: show/hide toggle button (`aria-pressed`), caps-lock hint.
- **Search**: leading search icon, clear button when non-empty, `type="search"`, `Esc` clears.
- **Form layout**: single column up to 640 px; two columns from `sm` only for short related fields. Action row at the bottom: primary first (left on mobile full width stacked, right-aligned on desktop), cancel as `ghost`. Long forms (card new, role editor) get a sticky action bar: `sticky bottom-0 bg-canvas/90 backdrop-blur border-t border-line p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]`.

### 4.3 Badges and chips

- **Badge** (read-only): `inline-flex h-5 items-center gap-1 rounded-full px-2 text-xs font-medium` (square 6 px radius variant for refs). Tones: `neutral | brand | success | warning | danger | info`, each `bg-{tone}-soft text-{tone}-soft-fg`. Optional 12 px leading icon. Keep the `tone` prop names used today (`red|amber|green|blue|violet|neutral`) as aliases mapped: red=danger, amber=warning, green=success, blue=info, violet=brand.
- **Status dot + label** (`StatusDot`): 8 px dot + `text-muted` label, for connection, shift status, sync status. Use for repeated lists where badges would be noisy.
- **Stage chip**: dot in stage colour + stage name, `bg-sunken`.
- **Filter chip** (toggle): `h-8 rounded-full border border-control px-3 text-sm`, pressed `bg-brand-soft text-brand-soft-fg border-brand` and `aria-pressed="true"`.
- **Count pill** (nav, column header): `min-w-5 h-5 rounded-full px-1.5 text-xs tabular-nums`; sidebar desk pill is `bg-danger-fill text-white` (blocking) or `bg-accent text-accent-fg` (open, nothing blocking).

### 4.4 Cards and panels

- `Panel` (existing): `rounded-card border border-line bg-surface p-4`. Add optional `title`, `actions` (header row with a bottom divider), `padding="none|compact|default"`, and `as` for the heading level. All current Panel children keep working.
- **Interactive card** (board tile, project card, agent card): the whole card is a `Link` with a visible hover (`hover:border-control hover:shadow-md`), active press, and focus ring; text inside is not underlined.
- **Board tile**: 3 lines max. Row 1: mono ref `text-xs text-subtle` left, age right. Row 2: title `text-base font-medium` clamp 2. Row 3: avatar+first name (or nothing when unassigned; drop the repeated "Unassigned" text), then only *exceptional* badges (blocked, rework N, large risk, waiting, full-suite). Left border 3 px in a state colour only for blocked (danger) and waiting (warning). The workability warning stays at bottom right.
- **Stat tile**: label `text-xs text-subtle`, value `text-2xl font-semibold tabular-nums`, delta/context `text-xs`.

### 4.5 Tables and lists

- Real `<table>` for Admin users, Metrics tables, HR comparison and Workstations on >= 768 px: `w-full text-sm`, header row `bg-sunken text-xs font-semibold text-muted` (sentence case, no uppercase), cells `px-3 py-2.5`, `border-b border-line`, row hover `bg-sunken/60`, sticky header inside scroll containers, numbers right-aligned `tabular-nums`. Row actions in the last column as a kebab menu.
- Below 768 px every table becomes a stacked list: each row a card with the primary cell as title and `dt/dd` pairs below (`@media` via a `data-label` attribute pattern or separate markup). No horizontal scrolling for data tables.
- Plain lists (ledger entries, handoffs, timeline): `divide-y divide-line`, not a stack of bordered panels, unless each item has its own actions.

### 4.6 Tabs

`Tabs` component (new, keyboard compliant): `role="tablist"` / `role="tab"` / `role="tabpanel"`, `aria-selected`, `aria-controls`, roving `tabIndex`, Left/Right/Home/End. Style: underline tabs, `h-10 px-3 text-sm font-medium text-muted`, active `text-fg` with a 2 px `bg-brand` bar; container `border-b border-line overflow-x-auto` (no wrap, scrolls with `scroll-snap`, fade mask at the edge on mobile). Used on: Organization (replace the hand-rolled one in `OrgDesigner.tsx`), Card detail on mobile, Project settings, Admin, Feed project. URL-synced via `?tab=` as the Organization page does today.

### 4.7 Dialog, sheet, drawer, menus

- **Dialog** (Radix, existing): `w-[min(92vw,32rem)]` (`lg` 40rem, `xl` 56rem for the workflow editor), `rounded-dialog bg-surface shadow-lg p-0`, header (title 16/600 + description + 40 px close icon button top right), scrollable body `px-5 py-4`, footer `border-t border-line px-5 py-3` with actions right aligned. **Below 640 px it becomes a bottom sheet**: `inset-x-0 bottom-0 max-h-[92dvh] rounded-t-dialog`, drag handle decoration, footer buttons full width stacked (primary on top), `pb-[env(safe-area-inset-bottom)]`. Focus trap and return focus come from Radix. `Dialog` keeps props `open, onOpenChange, title, description, children`; add optional `footer`, `size`, `dismissible`.
- **ConfirmDialog** (new): title is the action in question form ("Fire Marlowe?"), body states the consequence in one sentence (use the existing descriptions in `FireDialog`/Unlink), confirm button repeats the verb ("Fire agent", not "OK"), danger variant, cancel is the initial focus for destructive confirms. For irreversible org-level actions (unlink workstation, deactivate user) the body lists what happens. Use for: Fire, Unlink, Revoke invitation, Deactivate user, Delete schedule (replace `window.confirm`), Remove repository, Cancel card, Dismiss desk item (only for non-answered, to protect against mis-taps: lightweight inline "Dismissed. Undo" toast is better; see pages.md).
- **Drawer**: the mobile nav and the chat drawer. Radix Dialog as a side panel: `inset-y-0 left-0 w-[min(86vw,20rem)]`; chat `right-0 w-full sm:w-[28rem]`.
- **Menu** (Radix DropdownMenu, already a dependency but unused): user menu, card overflow menu, row kebabs. `rounded-control bg-surface border border-line shadow-md p-1`, items 36 px (44 touch), destructive items `text-danger`, separators. Radix gives arrow-key navigation and typeahead.
- **Popover/Command palette** (P3): `Ctrl/Cmd+K`.

### 4.8 Toasts

Success and info feedback for mutations that today either show nothing or a loose `<p role="status">Saved.</p>` (e.g. `ProjectSettings.tsx`, emerald-600 on white is 3.8:1, which fails AA). New `ToastProvider` + `useToast()` (Radix Toast or a 60-line custom): bottom-right on desktop, top-center below the top bar on mobile (so it clears the keyboard and safe area). Success 5 s (pauses on hover/focus), error stays until dismissed (`role="alert"`), others `role="status"` `aria-live="polite"`. Max 3 stacked. Content: icon, one sentence ("Settings saved"), optional action ("Undo", "View card"). Inline `ErrorBox` stays for form-level errors that need the context of the form.

### 4.9 Empty states

Pattern `EmptyState({ icon, title, description, action, secondaryAction, tone })`: centred in the panel, `py-10`, 40 px icon in a 64 px `bg-brand-soft text-brand-soft-fg` circle, title 16/600, description 14 `text-muted` max 44ch, one primary action. Three kinds: **first use** (explains what it is and offers the creating action), **filtered** ("No entries match "tabs". Clear filters"), **all clear** (positive: desk "All clear. Nothing is waiting on you." with a calm check icon, no action). Copy per page is in `pages.md`. Existing `data-testid`s on empty messages (`ledger-empty`, `desk-empty`, `feed-empty`, `taste-empty`, `schedules-empty`) must stay on the new component's root element.

### 4.10 Loading (skeleton) and errors

- `Skeleton` primitives (`SkeletonLine`, `SkeletonBlock`, `SkeletonAvatar`): `rounded bg-sunken bg-[linear-gradient(90deg,transparent,rgb(255_255_255/.5),transparent)] bg-[length:200%_100%] animate-shimmer` (dark: `rgb(255 255 255 / .06)`).
- Page skeletons mimic the layout: board = 5 columns x 3 tile skeletons; list pages = 4 row skeletons; card detail = header + two panels. Always `role="status"` with an `sr-only` label ("Loading board") so announcements and the `Spinner` `label` prop keep working. Show a skeleton only after 150 ms to avoid flashes (`useDelayedFlag`).
- `Spinner` stays for tiny inline use (button loading, 16 px), now an SVG ring, `role="status"`, text kept in `sr-only` ("Loading...").
- `ErrorBox` keeps `role="alert"`; style: `rounded-control border border-danger-fill/40 bg-danger-soft text-danger-soft-fg p-3` with alert icon and, where the query allows, a "Try again" button (`refetch`). Page-level fatal errors use the error empty state with the same retry.
- Offline/live: the `live-indicator` stays (`data-testid`, `data-state`); shown in the top bar as a dot + "Live"/"Offline" (offline: `bg-warning`, text "Reconnecting...").

### 4.11 Avatar, icons, misc

- **Avatar**: keep the initials avatar (`data-testid="avatar"`, `aria-label="Avatar for {name}"`). Change the fill to `hsl(h 50% 30%)`: white initials then measure at least 5.0:1 for every hue (the current `hsl(h 55% 38%)` drops to 3.1:1 for some hues such as yellow-greens, which fails AA for the 8 to 15 px initials). Size scale 18/24/32/40. Agents get a small status ring (idle, on shift pulsing accent, blocked danger) on the HR board.
- **Icons**: add `lucide-react` (MIT, tree-shaken, 1.75 stroke) or, if the owner wants zero new dependencies, a local `components/icons.tsx` with the ~30 icons listed in the implementation plan. 16 px in buttons/badges, 20 px in the sidebar, 24 px in empty states. Icons are `aria-hidden` unless they stand alone.
- **Kbd** hint chips for shortcuts in the command palette and tooltips.
- **Tooltip**: only for icon-only controls in the collapsed sidebar and truncated names; never for essential info (touch has no hover).
- **Scroll shadows / fade masks** on horizontally scrollable regions (board, tabs).

---

## 5. Layout primitives

- `AppShell` (see layout-and-navigation.md), `PageHeader` (title, optional back link/breadcrumb above, subtitle, actions; actions collapse into a menu < 640 px), `PageSection`, `Panel`, `SplitLayout` (main + 320 px rail, rail stacks under main < 1024), `StickyActionBar`.
- `PageHeader` change: `h1` is `text-2xl` with `text-wrap: balance`, **wraps** instead of truncating; `sub` row allows wrapping; actions: first action the page's primary, the rest `secondary`/`ghost`; more than 3 actions -> overflow menu.

## 6. Mapping from today's classes to tokens

| Today | Becomes |
| --- | --- |
| `bg-white dark:bg-zinc-900` | `bg-surface` |
| `bg-zinc-100 dark:bg-zinc-800` (neutral fills) | `bg-sunken` |
| `border-zinc-200 dark:border-zinc-800` | `border-line` |
| `border-zinc-300 dark:border-zinc-700` (inputs) | `border-control` |
| `text-zinc-500` | `text-subtle` (captions) or `text-muted` (secondary body) |
| `text-zinc-600 dark:text-zinc-400` | `text-muted` |
| `bg-indigo-600 hover:bg-indigo-500` | `bg-brand hover:bg-brand-hover` |
| `text-indigo-600 dark:text-indigo-400` | `text-brand-text` |
| `bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300` | `bg-danger-soft text-danger-soft-fg` |
| `bg-amber-*`, `bg-emerald-*`, `bg-sky-*`, `bg-violet-*` | `warning-soft`, `success-soft`, `info-soft`, `brand-soft` |
| `text-[11px]` | `text-xs` |
| `rounded-md` / `rounded-lg` | `rounded-control` / `rounded-card` |
