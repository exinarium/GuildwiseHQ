# Name and brand: Guildwise

Only user-facing branding changes. Package names (`@aom/*`), the `aom` CLI, `aom-runner`, env vars (`AOM_*`), DB names and the repo folder stay as they are.

- **Name:** Guildwise (written "Guildwise" in prose, lowercase `guildwise` in the wordmark)
- **Descriptor:** "Guildwise: your guild of AI agents"
- **Slogan:** "Many hands. One master." (login screen, marketing)
- **Domain:** guildwisehq.com (registered). Marketing lock-up: `logo-hq.svg` ("guildwise HQ").
- History: provisional name "Muster" (rejected candidates then: Brigade, Gaffer, Guildhall, Rota) was replaced by the owner's choice.

## Meaning and story

A guild is a body of skilled craftspeople who hold each other to a standard of work. "Wise" is the older sense of the suffix, "in the manner of" (likewise, otherwise), and also the plain meaning: knowing the trade. Guildwise is a guild run wisely: agents with defined roles (the HR board), a shared workflow (spec, build, review, test, finalize), a standard they must meet (the review and test gates), and one master who sets that standard and answers their questions at the desk.

The product is exactly that shape: many agents working in parallel, a single human accountable for the result. The slogan says it in five words: **Many hands. One master.** "Master" is meant in the guild sense (master craftsperson), the person whose standard the work is held to, not a hierarchy for its own sake.

Tone: calm, competent, crafted. No medieval imagery (no shields, scrolls, banners).

## Slogans

| Use | Line |
| --- | --- |
| **Primary slogan** (login, marketing hero) | Many hands. One master. |
| **Descriptor** (page meta description, app store line, footer) | Guildwise: your guild of AI agents |
| Alternative | Your guild of AI agents. |
| Alternative (longer marketing copy) | You set the standard. Your guild does the work. |
| Alternative (docs, blog) | Master the craft of running agents. |
| Alternative (hiring/onboarding pages) | Where AI agents learn the trade. |

## Logo

Files in this folder: `logo.svg` (mark + wordmark, wordmark in `currentColor`), `logo-light.svg` (for light backgrounds), `logo-dark.svg` (for dark and the ink sidebar), `logo-mark.svg` (square mark), `favicon.svg` (16 px optimised), `logo-hq.svg` (marketing lock-up with an "HQ" tag). Previews: `brand-preview/`.

**Concept.** A modern maker's mark: a **G** built from three separate arc segments (the skilled agents of the guild) whose crossbar runs into one **lime node** at the centre (the master, the same node that anchors the login constellation). Segments are separated by hairline gaps so it reads as a team, not a ring. Everything is geometric (butt-cut arcs, one round node), sits on the ink tile, and has no ornament.

**Wordmark case: lowercase.** Reasons: (1) it keeps the monoline, round-cap construction of the previous mark, which pairs with the geometric G and with Geist; (2) the tall `l`, `d` and the dotted `i`s give a distinctive rhythm that titlecase `G` would flatten, and the capital G already lives in the mark; (3) lowercase reads as calm and approachable for a self-hosted tool, while the full-name uses in running text and titles keep "Guildwise" in titlecase. Lowercase wordmark, titlecase everywhere text is typed.

**Palette.** Unchanged: ink `#0D1220` tile, white mark, lime `#D4F24A` node, cobalt stays the UI accent. No tweak was needed: the lime node on ink is the strongest single point of contrast in the system (12:1+), which is what the concept needs. Wordmark colours: `#0D1220` on light, `#FFFFFF` on dark.

**Small sizes.** The full mark has three gaps, which close up below about 24 px. `favicon.svg` is redrawn for 16 px: one continuous arc, 9/64 stroke, larger node, no hairline border. Use the favicon artwork for any rendering under 24 px.

**Usage.** On the ink sidebar use `logo-dark.svg` (the tile gets a faint white hairline so it does not vanish into the ink). Collapsed rail: `logo-mark.svg` at 32 px. Clear space: the diameter of the node on every side. Never recolour the node, never stretch.

## Where the name appears (for the builder)

All strings come from one module, see "Brand constants" in `implementation-plan.md`.

- `index.html` `<title>`: `Guildwise`. Per page: `Board · WEB · Guildwise`. Meta description: the descriptor.
- Sidebar header (`logo-dark.svg`), login brand panel (logo, slogan, descriptor), accept-invite page, 404.
- Favicon, `apple-touch-icon.png`, `theme-color` `#0D1220`.
- Email subjects/bodies in `apps/server` (invitation mail) may still say "Agent Org Manager"; flag to the owner, out of scope for the web app.
- README and USER-GUIDE headings: owner decision, not part of this UI work.
- Optional login footer line "Guildwise, formerly Agent Org Manager": decision for the owner.

## Domain

guildwisehq.com is registered. Use `guildwisehq.com` for the marketing site and as the default sender domain for invitation mail when the owner is ready. Still to check by the owner: trademark search for "Guildwise" (reasoned collisions: generic words "guild" and "wise" are common in unrelated products; no known developer tool named Guildwise at the time of writing, unverified), npm/GitHub org availability, and social handles.
