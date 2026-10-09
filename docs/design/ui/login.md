# Sign-in, invitation and account screens

Covers `pages/Login.tsx` (`/login`), `pages/AcceptInvite.tsx` (`/invite/:token`) and the "invalid invitation" state. There is no web setup/first-admin screen: the first admin is created with the server CLI (`README` quick start), so none is designed here. Section 6 gives the shared "not found" and "session expired" screens, which reuse the same frame.

Reference art: `docs/design/ui/login-art.svg` (pure SVG, 1200 x 900, `preserveAspectRatio="xMidYMid slice"`); logos `logo-dark.svg`, `logo-mark.svg`.

## 1. What is there today

`current/login-d.png`, `login-m.png`: a 384 px column with the text "Sign in", the grey text "Agent Org Manager", two bare inputs and a button on a white page. No brand, no password reveal, the failure text sits between the inputs and the button, `AcceptInvite` has no brand either and shows the invalid-link state as plain text with an underlined link, and the page does not respond to the product's dark theme beyond the body colour.

## 2. Concept

"The floor, seen from above." The brand panel is the dark ink field with a constellation: one lime node (the manager) in the middle, concentric rings of white nodes (the crew), thin lines converging inward, a few lime nodes lit (agents on shift). It is exactly the logo idea at scale, needs no photography, and is a single inline-able SVG.

Subtle life, all optional and disabled under `prefers-reduced-motion`:

- The lit lime nodes pulse (`opacity 1 -> .5`, 3.2 s, staggered via `animation-delay`).
- The central node has a slow expanding ring (`scale 1 -> 1.8`, `opacity .35 -> 0`, 4 s, `infinite`).
- The art drifts 8 px with the pointer (desktop only; skip on touch). Optional, P3.

Implementation: render the art as a React component (`<LoginArt/>`) built from the SVG so classes can be attached to nodes for the animation, or inline the file and select by `[data-lit]`. As a plain `<img src>` it still works (no animation).

## 3. Layout

### 3.1 Desktop (>= 1024): split screen, 55 / 45

```
+----------------------------------------------------------+---------------------------------+
|  ink field #0D1220 with the constellation                |  canvas (light or dark theme)   |
|                                                          |                                 |
|  [G] guildwise                       (logo-dark, 28 px)     |                                 |
|                                                          |        Welcome back             |   h1, text-3xl
|                                .  .   .                  |        Sign in to your guild |   muted
|                         .   o   .   o      .              |                                 |
|                    .         o  .  (@)  .   o              |   Email                         |
|                         o   .   o   .    o                |   [ you@company.com           ] |
|                              .  o    .                    |   Password                      |
|                                                          |   [ ************        (eye)  ] |
|                                                          |   Caps Lock is on               |   shown only when true
|  Many hands. One master.              (text-3xl, white)  |                                 |
|  Guildwise: your guild of AI agents   |   [        Sign in            ] |   full width, 44 px
|  . Every question reaches you with context               |                                 |
|  . Nothing leaves without your approval                  |   Forgot access? Ask your admin |   subtle
|  . Your machines, your repos, your vaults                |                                 |
|                                                          |   o Server reachable   v0.x     |   footer, 12 px
+----------------------------------------------------------+---------------------------------+
```

- Panel: `hidden lg:flex lg:w-[55%] bg-[#0D1220] text-white relative overflow-hidden`. Art absolutely positioned behind the text, `opacity-90`; a gradient scrim (`linear-gradient(to top, #0D1220 15%, transparent 60%)`) keeps the bottom copy readable (white on ink 18.7:1; secondary copy `#B4BDD0` 9.9:1).
- Logo top-left, 40 px from the edges. Tagline at the bottom-left, max 28ch per line.
- Form column: vertical centre, `w-full max-w-sm` inside `px-6`. The form column follows the user's theme (light/dark); the brand panel is always ink.
- The form sits on `canvas` with no card border (open layout looks calmer); on short viewports (< 640 px tall) the column scrolls and the brand copy hides.

### 3.2 Tablet (768 to 1023)

Brand panel becomes a 220 px high header band across the top (art cropped by `slice`, logo and tagline over it), form centred below. No side-by-side.

### 3.3 Mobile (< 768, e.g. 390 x 844)

```
+--------------------------------+
| ink band 168 px                |
|   [G] guildwise                   |
|   constellation (cropped)      |
|   Many hands. One master.     |
+--------------------------------+   rounded-b-[24px] overlap: form card pulled up 16 px
|  Welcome back                  |
|  Sign in to your guild      |
|                                |
|  Email                         |
|  [ you@company.com           ] |   44 px, 16 px text (no iOS zoom)
|  Password                      |
|  [ ************         (eye) ]|
|  [        Sign in            ] |   full width
|                                |
|  Forgot access? Ask your admin |
+--------------------------------+
   padding-bottom: env(safe-area-inset-bottom) + 24 px; layout uses min-h-dvh so the on-screen keyboard
   does not push the button out of reach (form scrolls into view on focus)
```

The ink band scales down gracefully; the three benefit bullets are dropped on mobile. Theme: band always ink; below it the user's theme.

## 4. Sign-in form spec

- Heading `h1`: "Welcome back". Sub: "Sign in to your guild." (Alternative copy for a fresh install is not needed.)
- Fields (use `TextInput`):
  - **Email**: `type="email"`, `name="email"`, `autoComplete="username"`, `inputMode="email"`, `autoCapitalize="none"`, `spellCheck={false}`, autofocus on desktop only (not on touch, to avoid the keyboard covering the art).
  - **Password**: `type="password"` with a trailing reveal button (`aria-pressed`, toggles `type`), `autoComplete="current-password"`.
- **Do not name the reveal button anything containing the word "password".** The e2e suite uses `getByLabel('Password')`, which matches `aria-label` text as well and would then hit two elements. Use `aria-label="Show characters"` / `"Hide characters"`.
- Caps Lock hint: on `keydown/keyup` read `event.getModifierState('CapsLock')`; show a warning-tone line with an icon "Caps Lock is on" under the password (`role="status"`). Never block submit.
- Submit: full width primary "Sign in" (accessible name stays exactly `Sign in`; pending label "Signing in..." and `aria-busy`, button disabled, spinner at the left). Enter submits. The form keeps `aria-label="Sign in"`, `noValidate`.
- Remember me: not offered (cookie session policy is the server's; do not invent). Forgot password: a link "Forgot your password?" to `/forgot-password` (email form, neutral answer), then `/reset-password/:token` (new password twice; on success back to `/login` with a "Your password is changed" notice).
- Footer line (12 px, subtle): connection check text "Server reachable" is **not** built (no health call from the login page); instead show the product line "Self-hosted · your data stays on your machines" and the version if the server exposes it. Keep it static copy; drop anything that implies a feature that does not exist.
- Security niceties that cost nothing: `autocomplete` values as above so password managers work; do not clear the email on failure; clear the password and focus it after a failed attempt.

### Copy

| Place | Text |
| --- | --- |
| Tab title | `Sign in · Guildwise` |
| Panel headline | Many hands. One master. |
| Panel sub | Guildwise: your guild of AI agents |
| Bullets | Every question reaches you with context / Nothing leaves without your approval / Your machines, your repos, your vaults |
| H1 | Welcome back |
| Sub | Sign in to your guild. |
| Email label | Email |
| Password label | Password |
| Button | Sign in |
| Help | Forgot your password? (link to /forgot-password) |

## 5. States

| State | Behaviour |
| --- | --- |
| Initial | Empty fields, no errors. Submit enabled (validation on submit, as today, so autofill that did not fire `change` still works). |
| Field validation (client) | Email invalid: "Enter a valid email address" under the field, `aria-invalid`, focus the first invalid field. Empty password: "Enter your password". Errors have `role="alert"` (as `Field` does today). |
| Submitting | Button disabled + spinner + "Signing in..."; fields `readOnly` (not `disabled`, so values stay and screen readers keep context). |
| Wrong credentials (401/400) | A form-level alert **above the submit button** (not between fields): icon + "That email and password do not match. Check them and try again." (`role="alert"`, danger soft). Keeps `role="alert"` so `getByRole('alert')` in e2e still finds it. Password cleared and focused. Do not say which one was wrong. |
| Rate limited (429) | "Too many attempts. Wait a minute and try again." Button re-enabled after 5 s. (`apps/server/src/routes/auth.ts` has per-IP rate limiting.) |
| Account deactivated (403, if the server distinguishes) | "This account is deactivated. Ask your admin." |
| Network / 5xx | "Cannot reach the server. Check your connection and try again." with a Retry action; the form stays filled. |
| Already signed in | Redirect to `next` (already implemented via `safeNext`). Keep the same-origin check. |
| Session expired | `RequireAuth` redirects here with `?next=`. Show an info banner "Your session ended. Sign in to continue." when the redirect came from an authenticated page (pass `state: { expired: true }`). |
| Success | Navigate to `next`. No success toast on login. |

## 6. Accept invitation (`/invite/:token`)

Same frame (brand panel + form column; same mobile band). Differences:

- H1 "Join {Organization}" is not available (the API returns only the email); use "You are invited". Sub: "Create your account for **ada@company.com**" (email shown bold, read-only, also in a disabled input labelled "Email" for password managers so the username is captured; `autoComplete="username"`).
- Fields: Display name (autofocus), Password (hint "At least 12 characters"; strength meter below: a 4-segment bar labelled by text "Too short / OK / Good / Strong", based on length plus variety, purely advisory; the only rule enforced is the schema's 12 to 256), Confirm password. Each with the reveal toggle, named "Show characters" for the first and "Show characters (confirmation)" for the second so labels stay unique (`getByLabel('Password', { exact: true })` and `getByLabel('Confirm password')` are used by e2e; neither may match the toggles).
- Button "Create account" (the e2e regexp `/accept|create|continue|join/i` matches it). After success the app lands on `/`; consider a one-time welcome toast "Welcome to Guildwise, {name}".
- Inline mismatch check on blur of the confirmation: "Passwords do not match" (`role="alert"` on submit as today).
- **Invalid/expired/used link** (`info.isError`): same frame, centre card: key icon in a `warning-soft` circle, H1 "This invitation link does not work", body "It may have expired or already been used. Ask your admin to send a new one.", secondary button "Go to sign in" (a link styled as a button, keeps the destination `/login`). `Invitation unavailable` text can stay as the `sr-only` heading if any test wants it (no test does today).
- **Checking invitation** (`info.isPending`): skeleton of the form (two shimmer bars) rather than text.

## 7. Related full-page states (same frame, brand panel hidden, centred card)

- **Not found** (`*` currently redirects to `/`; keep that, so no 404 page is required). If the owner wants one later: mark icon, "We could not find that page", button "Back to the board".
- **Fatal render error** (add an `ErrorBoundary` at the router level): "Something went wrong" + Reload button + collapsed technical details. P2.

## 8. Accessibility checklist

- [ ] One `h1` per screen; the brand panel's headline is a `p` (decorative marketing copy), the SVG art is `aria-hidden="true"` and `role="presentation"`.
- [ ] Brand panel text meets AA: white on ink 18.7:1, secondary `#B4BDD0` on ink 9.9:1, lime on ink 14.8:1; the gradient scrim never lowers the text below 7:1.
- [ ] Labels are real `<label for>` (existing `Field`); placeholders are examples, not labels.
- [ ] Error text is associated with the field via `aria-describedby`, form-level error is `role="alert"`, focus moves to the first error / the cleared password.
- [ ] Password reveal is a real button, 44 px target, `aria-pressed`, keyboard operable, and does not contain the word "password" in its name.
- [ ] Caps Lock hint is `role="status"` (polite), not an alert.
- [ ] Autofill and password managers: correct `autocomplete`, no `readOnly` tricks, no custom paste blocking.
- [ ] Works with browser zoom 200 % and at 320 px width: brand band collapses, no horizontal scroll.
- [ ] Reduced motion: node pulses, ring and parallax off.
- [ ] Both themes: form column follows the theme; contrast verified in the design-system tables; the focus ring is `--ring` (6.4:1 light, 8.4:1 dark).
- [ ] `<title>` per screen, `lang="en"`, `color-scheme` meta kept.
- [ ] Touch: inputs 16 px font, 44 px height, `inputMode`, no autofocus on touch devices.

## 9. Implementation notes

- Files: `pages/Login.tsx`, `pages/AcceptInvite.tsx` use a new `components/auth/AuthFrame.tsx` (brand panel + children slot) and `components/auth/LoginArt.tsx`, `components/Logo.tsx` (`<Logo variant="dark|light|auto" />`, `<LogoMark />`, inline SVG from `logo*.svg`, `role="img" aria-label="Guildwise"`).
- Keep `safeNext()` export (it is imported by tests/other files), the `LoginRequestSchema` validation, the `aria-label="Sign in"` / `"Accept invitation"` form names and the field labels `Email`, `Password`, `Display name`, `Confirm password`.
- Copy `docs/design/ui/login-art.svg` to `apps/web/src/assets/login-art.svg` (Vite hashes and serves it same-origin; the CSP `img-src 'self' data:` allows it). Do not reference remote images or fonts.
- Add the favicons in `index.html`: `<link rel="icon" href="/favicon.svg" type="image/svg+xml">` (copy `favicon.svg` to `public/`), plus a `public/apple-touch-icon.png` (180 px render of `logo-mark.svg`) and `<meta name="theme-color" content="#0D1220">`; update `<title>` to `Guildwise`.
