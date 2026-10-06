# UI redesign: decisions (orchestrator, 2026-10-05)

The owner delegated the naming and visual design ("come up with a creative name", "really improve the UI") and is away
overnight. These are provisional decisions on the designer's open questions. The owner reviews them on the deployed result.

1. **Name: Guildwise HQ** (owner decision, replaces the provisional "Muster"; domain guildwisehq.com; descriptor "Guildwise HQ: your guild of AI agents"; slogan "Many hands. One master."). Use it everywhere a user sees the product: web UI, page titles, login, invitation emails, README
   title and the user guide. No "formerly" wording, and no product name in pull request text (2026-10-06). Internal identifiers stay unchanged: `@aom/*`, `aom`
   CLI, `aom-runner`, env vars, DB.
2. **Sidebar:** always dark (ink #0D1220) with the lime accent, as designed; content areas follow light/dark.
3. **Dependencies:** approved. Self-hosted Geist via fontsource (CSP `font-src 'self'`), `lucide-react` icons, and the
   Radix primitives the plan needs. No CDN.
4. **Mobile:** drawer only. No bottom tab bar.
5. **Priority:** the dispatcher orders `priority ASC`, so **1 = most urgent, 9 = least**. The UI labels it
   "Priority (1 = urgent … 9 = whenever)" and shows a chip such as "P1".
6. **Desk:** a grouped list with filter chips, not a two-pane inbox.
7. **Nav renames:** approved: "HR" becomes "Agents", "Organization" becomes "Roles & workflows". Routes stay the same, or
   redirect.
