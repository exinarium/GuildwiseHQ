# Agent Org Manager: user guide and handover (PDF)

`Agent-Org-Manager-User-Guide.pdf` is the illustrated user guide and handover for the app. It has the same format and build pipeline as the
"Municipal Account Management" guide. Every picture is a real screenshot of the running app with fake demo data (`@demo.local`, `example.com`).
The demo agents run on the mock runtime; no real Claude session, GitHub or Jira is used.

## Layout

| Path | What it is |
| --- | --- |
| `parts/head.html` | The CSS (copied from the reference guide) |
| `parts/cover.html`, `parts/ch01.html` ... `parts/ch15.html` | Cover and chapters (chapter 3 is `ch03a.html` + `ch03b.html`) |
| `assemble-guide.mjs` | Joins the parts, builds the contents from the headings, writes `guide.html` |
| `guide.html` | The assembled guide (generated; edit the parts, not this file) |
| `build-guide.mjs` | Two-pass PDF build with Playwright Chromium; the contents get real page numbers from invisible `TOCMARK_` markers |
| `prepare-assets.mjs` | Converts `raw/*.png` into `assets/*.jpg` (flattened, at most 1600 px wide, JPEG quality 82) |
| `raw/` | The raw PNG screenshots (written by the Playwright project `guide`) |
| `assets/` | The figures used by `guide.html` |

## Rebuild the PDF from the existing pictures

```sh
export NVM_DIR=~/.nvm; . ~/.nvm/nvm.sh
cd <repo>
pnpm install
pnpm --filter @aom/e2e exec playwright install chromium   # once
node docs/guide/assemble-guide.mjs
node docs/guide/build-guide.mjs        # writes docs/guide/Agent-Org-Manager-User-Guide.pdf
pdfinfo docs/guide/Agent-Org-Manager-User-Guide.pdf
```

`build-guide.mjs` uses Playwright and `pdf-parse`, both devDependencies of the `e2e` package.

## Take the screenshots again

The project `guide` (spec `e2e/tests/guide-screenshots.spec.ts`, helpers `e2e/support/guide.ts`, setup `e2e/guide-global-setup.ts`) is only added to the
Playwright config when `AOM_E2E_GUIDE=1`, so `pnpm e2e` never runs it. It needs Postgres on 127.0.0.1:5433 and Mailpit on 1025/8025, and the built
server, web and runner (`pnpm build`). Use a separate database and port when another test run is active:

```sh
cd e2e
export AOM_E2E_GUIDE=1 AOM_E2E_DB=aom_e2e_b AOM_E2E_PORT=4611 AOM_E2E_DIR=/tmp/aom-e2e-b
# seed the demo world (about 8 minutes) and take every screenshot; keep the stack running afterwards
AOM_GUIDE_KEEP=1 npx playwright test --project=guide
# take only some screenshots again from the kept stack (the seed steps are skipped)
AOM_GUIDE_KEEP=1 AOM_GUIDE_REUSE=1 npx playwright test --project=guide --grep "capture: the board"
# stop the kept server and runners: kill the pids in /tmp/aom-e2e-b/pids.json (server, runners)
node ../docs/guide/prepare-assets.mjs     # needs sharp: mkdir -p /tmp/guide-tools && cd /tmp/guide-tools && npm init -y && npm i sharp
```

Without `AOM_GUIDE_KEEP` the stack is stopped at the end, like in the default e2e run. The tests named `seed: ...` build the world and are recorded in
`$AOM_E2E_DIR/guide-state.json`; the tests named `capture: ...` only look (the few that change something say so in the spec).

## Where the numbers in chapter 1 and 12 come from

`pnpm typecheck`, `pnpm lint`, `pnpm test` (unit and integration, Postgres on 5433) and `pnpm e2e` on 4 October 2026.
