# GWP-29: Business mode: show Vault and Ledger as Knowledge and Rules & decisions

## Question

In a business organization, every place in the web app that says "Vault" or "Ledger" should say "Knowledge" and
"Rules & decisions". Standing orders should read as "rules" and decision entries as "decisions". Dev organizations stay
exactly as they are. Only the displayed text changes. Routes, API paths, event names, `aom` commands, DB columns, vault
paths and agent-facing texts keep their names. All renamed words must come from one helper keyed by org mode.

How do we do that without scattered string edits, without changing anything in dev orgs, and so that strings added
later (GWP-24 review dates, GWP-25 document vault, GWP-28/30/31) go through the same helper?

## Findings

### Where the words appear today

Short labels (nav, titles, buttons, toasts, aria-labels) live in `nav-config.ts`, `Breadcrumbs.tsx`, `pages/Ledger.tsx`,
`components/LedgerForm.tsx`, `pages/Desk.tsx`, `lib/desk.ts`, `pages/Vaults.tsx`, the capabilities components, and a
number of components with sentences that mention the vault or the ledger. The help layer holds more: `help/glossary.ts`,
`help/page-help-content.ts`, `lib/tour.ts`, `lib/videos.ts`, `help/articles/*.md` and `whats-new/entries/*.md`.

Not shown to an org user, so out of scope: `components/auth/AuthFrame.tsx` (before login, no org), `GraphStatusPanel.tsx`
(graph screens are hidden in business orgs by GWP-27), code comments, test-ids, query keys, routes.

### Text that is stored, not written in the web code

- **Default vault names.** The server creates vaults named `Organization vault` and `Project vault`. The DB must not
  change, so the web shows the default names through the helper: a stored default name maps to the business name, and any
  other name is shown as it is.
- **Server-made desk items.** The vault-conflict desk title and the HR recommendations are built per org, so the server
  can choose the words when it creates them.
- **Agent-facing server text** (shift briefs, `aom` output) stays as it is (requirement 5).

### The assistant topic `ledger-and-vaults.md`

It is generated from the web help article by `pnpm --filter @aom/server assistant:pack`. The pack feeds the public
landing-page assistant (no org, no mode), so its text keeps the dev words. The article's frontmatter `keywords` gain
`rules`, `rules & decisions`, `knowledge folder`. After any `.md` change, regenerate the pack and commit it.

## Recommendation and design (option C)

One `ORG_TERMS` map holds the words for both modes in `packages/shared/src/orgs/terms.ts`, with `orgTerms(mode)`,
`rewordForOrg(text, mode)` (identity in dev; whole-word, case-matching rewrite built from `ORG_TERMS.business`, guards
for routes, anchors, `vault:` paths, ids and `aom` commands) and `defaultVaultName(name, mode)`. The web reads it through
`useOrgTerms()`. Short labels use keys; sentences keep their dev literal wrapped in `t.reword(...)`. Markdown and help
data are reworded at render, never inside code spans or hrefs. The server uses the terms for the vault-conflict desk
title and the HR recommendations.

## Acceptance criteria → tests

- Business org shows no "Vault" or "Ledger": a business page-walk test.
- Dev org unchanged: the same walk in dev mode, plus all existing web tests unchanged.
- One helper, both modes asserted: `packages/shared/test/org-terms.test.ts`.
- URLs, API paths, events, aom commands unchanged: text only; run web, shared and server unit suites.
