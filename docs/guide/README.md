# Guildwise HQ: the illustrated user guide (PDF)

`Guildwise-HQ-User-Guide.pdf` is the illustrated edition of [`docs/USER-GUIDE.md`](../USER-GUIDE.md). The Markdown file is the **single source of the text**: the PDF is built from it, so the two never drift apart. Every picture is a real screenshot of the running app with fake demo data (`@demo.local`, `example.com`). The demo agents run on the mock runtime; no real Claude session, GitHub or Jira is used.

## Layout

| Path | What it is |
| --- | --- |
| `../USER-GUIDE.md` | The guide (text, figure references, table of contents). Edit this. Figures are `![Caption](guide/assets/name.jpg)` lines; callouts are blockquotes starting with **Tip**, **Good to know**, **Watch out**, **In the app** or **Before you start** |
| `parts/head.html` | The CSS of the PDF (Guildwise colours, Geist font) |
| `parts/cover.html` | The cover (logo, hero screenshot, edition) |
| `assemble-guide.mjs` | Converts `USER-GUIDE.md` to `guide.html`, builds the contents and rewrites the contents list inside `USER-GUIDE.md`; stops when a referenced figure is missing |
| `guide.html` | The assembled guide (generated; do not edit) |
| `build-guide.mjs` | Two-pass PDF build with Playwright Chromium; the contents get real page numbers from invisible `TOCMARK_` markers |
| `prepare-assets.mjs` | Converts `raw/*.png` into `assets/*.jpg` (flattened, at most 1600 px wide, JPEG quality 80) |
| `raw/` | The raw PNG screenshots (written by the Playwright project `guide`) |
| `assets/` | The figures used by the guide, the logos and the fonts |

## Rebuild the PDF from the existing pictures

```sh
export PATH=~/.nvm/versions/node/v22.23.2/bin:$PATH
cd <repo>
corepack pnpm install
corepack pnpm --filter @aom/e2e exec playwright install chromium   # once
node docs/guide/assemble-guide.mjs
node docs/guide/build-guide.mjs        # writes docs/guide/Guildwise-HQ-User-Guide.pdf
pdfinfo docs/guide/Guildwise-HQ-User-Guide.pdf
```

`build-guide.mjs` uses Playwright and `pdf-parse`, both devDependencies of the `e2e` package.

## Take the screenshots again

The project `guide` (spec `e2e/tests/guide-screenshots.spec.ts`, helpers `e2e/support/guide.ts`, setup `e2e/guide-global-setup.ts`) is only added to the Playwright config when `AOM_E2E_GUIDE=1`, so `pnpm e2e` never runs it. It needs Postgres on 127.0.0.1:5433 and Mailpit on 1025/8025, and the built server, web and runner (`pnpm build`). Use a separate database and port when another test run is active:

```sh
cd e2e
export AOM_E2E_GUIDE=1 AOM_E2E_DB=aom_e2e_g AOM_E2E_PORT=4621 AOM_E2E_DIR=/tmp/aom-e2e-g
# seed the demo world (about 10 minutes) and take every screenshot; keep the stack running afterwards
AOM_GUIDE_KEEP=1 npx playwright test --project=guide
# take only some screenshots again from the kept stack (the seed steps are skipped)
AOM_GUIDE_KEEP=1 AOM_GUIDE_REUSE=1 npx playwright test --project=guide --grep "capture: cards"
# stop the kept server and runners: kill the pids in /tmp/aom-e2e-g/pids.json (server) and the runners
mkdir -p /tmp/guide-tools && (cd /tmp/guide-tools && npm init -y && npm i sharp)   # once
node ../docs/guide/prepare-assets.mjs
```

The global setup gives the stack its own git identity (`GIT_CONFIG_GLOBAL`, the demo owner Pieter Demo), because commits are refused without one. Manual QA is switched off for the Web shop while the history is seeded and on again for the last seed step (one card in QA). The mock DevOps engineer cannot start real services: the capture of the Run a branch panel sets the environment to running in the guide database, and puts it back afterwards.

Without `AOM_GUIDE_KEEP` the stack is stopped at the end, like in the default e2e run. The tests named `seed: ...` build the world (organization of Pieter with an Admin and a Member, a Guest, workstations, agents, cards in every state, a phase, schedules, interests, budgets, a platform administrator with support requests, and the next morning's floor report; the last seed step moves the test clock to the next morning) and are recorded in `$AOM_E2E_DIR/guide-state.json`; the tests named `capture: ...` only look. The one capture that changes something (`budgets`) puts the budget back.

## Adding a figure

1. Add `![Caption](guide/assets/my-figure.jpg)` to `docs/USER-GUIDE.md`.
2. Add a `snap(page, 'my-figure', ...)` to a `capture:` test in the spec and run it.
3. Run `prepare-assets.mjs`, `assemble-guide.mjs` and `build-guide.mjs`.

## Recording a video

The training videos (Getting started and one per section) are listed in [`VIDEO-PLAN.md`](VIDEO-PLAN.md). Each is a Playwright spec in `e2e/video/<slug>.spec.ts` that drives a fresh demo stack (organization "Acme", Owner "Alex Morgan", mock agents) while an offline voice (Kokoro `af_heart`) reads `e2e/video/narration/<slug>.ts`. Output goes to `media/videos/<slug>.{webm,mp4,vtt,json}`.

Once per machine: Postgres on 127.0.0.1:5433 and Mailpit on 1025/8025 (as for `pnpm e2e`), `pnpm build` (the stack runs the built server, web and runner), and `e2e/video/setup-voice.sh` (Kokoro, the `af_heart` voice and a static ffmpeg into `~/.cache/aom-video`). Rebuild with `pnpm build` after the web app, server or runner changes.

**One video**

```sh
e2e/video/record.sh backlog
```

**A batch**, one video after the other, each on a fresh stack and database:

```sh
e2e/video/record.sh board desk intake
```

**In parallel**: every concurrent run needs its own port and database, nothing else; the scratch directory follows the port (`aom-e2e-video-<port>`, under `AOM_VIDEO_DIR_BASE` or `TMPDIR`).

```sh
AOM_VIDEO_PORT=4672 AOM_VIDEO_DB=aom_video_a e2e/video/record.sh board desk intake &
AOM_VIDEO_PORT=4673 AOM_VIDEO_DB=aom_video_b e2e/video/record.sh ledger vaults costs &
wait
```

The defaults are port 4671 and database `aom_onboard_video`. The database is dropped and created at the start of every video, so never point two runs at the same one, and never at a database you want to keep. A run stops its own server and runners at the end; if you kill it, stop the leftovers named in `<scratch dir>/pids.json`. `AOM_VIDEO_OUT` writes the files somewhere other than `media/videos` (a trial run); `AOM_VIDEO_PACE=0.5` halves the pauses between clicks (the voice still sets the pace).

**A new video**: copy `e2e/video/template/slug.spec.ts` to `e2e/video/<slug>.spec.ts` and `e2e/video/narration/slug.ts` to `e2e/video/narration/<slug>.ts`, follow the entry in `VIDEO-PLAN.md`, record it, look at it, then set `published: true` for the slug in `apps/web/src/lib/videos.ts` and commit the spec, the narration and the four files. The Help article, the tour step and the page help of the section then show it; nothing links to a video that is not published.

Shared on the machine, so not parallel-safe beyond what is described: the voice audio cache (`~/.cache/aom-video/audio`, safe to share: files are written under a private name and renamed), Mailpit, and the Postgres container (each run uses its own database). The finished WebM and MP4 must each stay under 20 MB (the spec fails otherwise).
