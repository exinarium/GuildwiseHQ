# Run steps and deploy setup for people who do not code

Status: design, 2026-10-20. Input: `.claude/worktrees/deploy-run-ux-requirements.md` (owner requirements R1-R10),
`docs/design/ceo-front-door.md` sections 9-10, the code as of today.

---

## 0. What exists today (checked in the code)

| Area | Where | What it does today | Gap against the requirements |
|---|---|---|---|
| Run plan schema | `packages/shared/src/runs/plan.ts` | `RunPlan {repos, setup[], services[], notes}`, steps are argv arrays, health `http/tcp/log/none` | Fine as an engine format. No labels, no "kind of step", no confidence. |
| Run plan save | `apps/server/src/commands/runs.ts` `applyRunPlanSaved` (from `aom run ready`), event `RunPlanSaved` (`packages/shared/src/events/run.ts`) | One plan per (project, **workstation**), fingerprinted by BUILD.md hash + run settings hash; `findReplay` sends it to `run.start.replay`; a failed replay files a DevOps `run` request | Only DevOps can produce a plan. A new workstation starts from zero. |
| Run settings UI | `apps/web/src/components/runs/RunSettings.tsx` (Project settings > Run and test) | Free-text run instructions, build guide paths, declared services as text boxes with mini-syntax (`http:5173:PORT`, `tcp:5432`); saved plans shown read-only | R2/R3: text boxes, syntax, no edit of the real plan. |
| Deploy targets | `apps/web/src/components/DeployTargetsPanel.tsx`, `apps/server/src/commands/deploy-targets.ts` | name, kind `local_docker|remote_ssh`, workstation + ssh alias (remote only), app URL, notes. `production` is settable only inside the per-target **Testing** expander (`runs/TargetTesting.tsx`). `checkShape` refuses a workstation on a `local_docker` target. | R1: production not visible where the target is made. R10: no reachability, no "which computer deploys". |
| Delivery recipe | `packages/shared/src/delivery/recipe.ts`, vault `delivery/recipe.yaml` + `delivery/scripts/*.sh` | Owner approves an exact bundle hash; drift refuses runs; `deploy.exec` re-hashes from the vault commit, runs the script unsandboxed as the user, health + smoke | Only DevOps/CEO (`aom recipe save`) or a person editing the vault can author it. |
| Delivery UI | `components/delivery/DeliveryPanel.tsx`, `GatesPanel.tsx` on `/deploys` | Mode select, lint, "Approve this version", deploy buttons | No authoring at all. |
| SSH | `apps/runner/src/forge/ssh.ts` | Git-host keys (`~/.ssh/aom_<provider>`), runner known_hosts, never reads private keys | Nothing for deploy hosts. |
| DevOps requests | `POST /api/devops/requests`, `DevOpsRequestContext.requestKind: 'run'|'recipe'` | Free-text request; `run` sets up a run env; `recipe` drafts a recipe | No structured, reviewable result. |

Owner's real setup (first adopter, inspected read-only):
- **UAT:** `~/.config/aom-uat/docker-compose.yml`, compose project `aom-uat`, services `postgres` (volume `pgdata`),
  `app` (`build: /path/to/guildwise`, i.e. the main checkout, `env_file: secret.env`),
  `mailpit`; `http://localhost:4700`; backups in `~/.config/aom-uat/backups/*.sql.gz`.
- **Production:** ssh alias `prod-server` (in `~/.ssh/config`, `IdentitiesOnly yes`), `/opt/app`,
  compose with `image: ${GUILDWISE_IMAGE}` from `.env`, image `guildwise-hq:<sha>` built on the workstation and loaded on
  the server, DB backup to `/opt/app/backups`, `.env.bak-before-<sha>`. The repo has `deploy/Caddyfile`, so a
  Caddy proxy is expected on the server.

---

## 1. Decision summary

1. **One structured setup, compiled to today's formats.** The run steps stay a `RunPlan`. The deploy setup becomes
   `delivery/setup.json` (new schema `DeliverySetup`), which a pure, versioned compiler in `packages/shared` turns into
   `delivery/recipe.yaml` + `delivery/scripts/<env>.sh`. All three files are in the bundle, so **the approval hash,
   drift detection, `deploy.exec` and the audit do not change**. The guided view and the developer view edit the same
   `setup.json`. A developer can still hand-edit a script; that environment then shows as "custom" (read-only in the
   guided view) until they choose "Back to guided".
   - Rejected: the runner interprets structured steps at deploy time (new executor, a second trust path, an old runner
     cannot run it, and what runs would no longer be a readable script the owner approved).
   - Rejected: keeping the structured setup in Postgres only (the approved hash would no longer cover what produced the
     scripts, and `delivery/` is already the single source of truth).
2. **The run plan gets an owner-confirmed, project-wide version.** `RunPlanSaved` gains an optional `source`
   (`devops|owner|scan`) and may have `workstationId: null` (project-wide). `findReplay` takes the workstation's own
   plan first, then the project-wide one. An owner plan is not invalidated by BUILD.md or run-instruction changes (the
   owner's word wins), only by a failed start. The runner needs no change (`replay.buildHash: null` already means "do
   not compare").
   - Rejected: a parallel "declared plan" next to the saved plans (two sources of truth; the declared services form is
     already confusing).
3. **"Scan with DevOps" is a DevOps request of a new kind** (`run_scan`, `deploy_scan`) that ends with a **structured
   proposal** submitted through a new `aom setup propose` call, validated against shared schemas, stored as an event
   and reviewed field by field. DevOps never saves a plan or recipe in a scan, and it never runs a write against a
   target: environment facts come from the deterministic probe (point 4), which DevOps also calls.
   - Rejected: parsing DevOps's prose report (not reviewable, not testable).
4. **Detection is deterministic runner code, not a model.** New durable runner command `deploy.probe` with fixed,
   read-only probes (local Docker; `ssh -G` / BatchMode connect tests; a fixed read-only probe script over ssh). Results
   are structured and redacted on the workstation (names and shapes, never values). The "Found / Will change / Will
   not touch" list is a pure function `planChanges(setup, probe)` in shared code, the same on web and server.
5. **Adopt, never replace.** Templates are written against what the probe found: they reuse the existing compose file,
   project name, folders, volumes, `.env` and proxy; they rebuild only the app service (`--no-deps`), never run `down`,
   `rm`, `-v`, `--remove-orphans`, `prune`, and never overwrite a config file without a dated backup next to it. Setting
   things up that do not exist yet (Docker, folders, proxy, HTTPS) is a separate, confirmed, one-time `deploy.prepare`
   step (v2), never part of a deploy script.
6. **SSH: use what works, offer a dedicated key, never edit.** The default is "Use the sign-in this computer already
   has" (the runner calls `ssh <alias>` as the user, as today). A dedicated deploy key (v2) lives in the runner's data
   directory, is offered and recommended, never forced; `~/.ssh/config`, existing keys and the server's
   `authorized_keys` are only ever *appended to*, and only after an explicit confirmation that shows the exact change.
7. **Safe defaults compiled into the recipe:** UAT `trigger: after_merge` (existing 2 minute debounce),
   `releasedBy: auto`, `gate: none`; production `trigger: on_request`, `releasedBy: owner`, inline gate
   `{requires:[{envHealthy:<uat>, sameCommit:true}], approvers:['owner']}`. Lint already refuses production with
   `auto` + `none`.

No new external dependency. No ADR needed beyond this document: the only new pattern is "structured file compiled to
the approved bundle", which keeps the existing authorization model.

---

## 2. User journeys

Personas: **Mia** (owns a small business, no coding, uses Guildwise on her laptop and phone; her office has a PC with
the workstation runner), **Pieter** (the owner and a developer; first adopter).

### J1. Mia: run steps for a new project (so card tests can run)
1. Project settings > **Run and test** shows "How to start this app: not set up yet" with **Scan with DevOps** (primary)
   and **Set up myself**.
2. She taps Scan. A progress card: "DevOps is reading the project on Office PC... usually 2-5 minutes. You can leave
   this page." (Push notification when ready.)
3. Proposal screen: "DevOps found 3 steps and 2 parts". Each row has a badge: **Found** (with "from package.json"),
   **Guessed** (amber, "please check"), **Unknown** (red, a question in plain words, e.g. "Which port does the website
   use? DevOps could not tell. Usually 3000.").
4. She answers the one question, taps **Test these steps**: Guildwise starts the app once on Office PC and shows
   "Started. Open it: http://localhost:3000" or the failing step in plain words.
5. **Use these steps** saves the plan for the whole project. Card integration tests now replay it.

### J2. Mia: deploy "on this computer" (UAT / office server)
1. Project > **Phases and deploys** > **Set up deploys**. "Where should the test copy of your app run?" -> **On this
   computer (Office PC)**.
2. Guildwise checks Office PC (probe). Found: "Docker is installed. A running app called *shop-uat* (3 parts) answers at
   http://localhost:8080." Choice: **Use shop-uat** (default) / **Start a new copy** / **Let DevOps look**.
3. "When should it update?" default **Automatically after changes are merged** (explainer: "It waits 2 minutes so a
   few merges become one update").
4. Review: Found / Each update will / Will not touch. **Try it without changing anything** (dry run), then **Save**.
5. Approve: as the Owner she sees "Approve this version" right there (her own setup still needs her approval as the
   audit record). Done; the card shows "Test copy: ready, updates after merge".

### J3. Mia: deploy "on my VPS", existing SSH sign-in
1. "Where should the live site run?" -> **On my own server (VPS)**.
2. "How do you sign in to your server?" Guildwise lists the servers Office PC can already reach:
   "**prod-server** (203.0.113.10, user root): this computer can sign in" with **Use the sign-in this computer
   already has** (default, recommended for now). Below: "Also add a dedicated Guildwise key (recommended)" as an
   unchecked option (v2), and **Connect a different server**.
3. Probe of the server (read-only). Found: "App folder /opt/app; app image guildwise-hq:4f2c1ab; database
   (postgres, kept in volume pgdata); web address https://hq.example.com through Caddy; backups folder (latest 2 days
   ago)". A checkbox **This is the live site your customers use (production)** is pre-ticked and explained.
4. "Each release will": back up the database, save a copy of the settings file, build the app from the approved
   version on Office PC, copy it to the server, switch only the app, check the site, switch back if it is not healthy.
   "Will not touch": database container, Caddy, other folders.
5. "When should it go live?" **Only when I press Release**, with **Only after the test copy is healthy on the same
   version** and **I approve each release** (both on, explained; turning either off moves you to the developer view).
6. Secrets: if the setup names any ("SHOP_SMTP_PASSWORD"), "Stored only on Office PC; Guildwise never shows it again"
   with **Set** / **Already set**.
7. **Try it without changing anything** (dry run against the server), **Save**, **Approve this version**.

### J4. Mia: VPS with no SSH set up yet (v2)
1. **Connect a different server**: address, username (default `root`, hint "your hosting company's email says this"),
   then **How do you sign in?** -> "With a password" / "With a key file my host gave me" / "My hosting panel has a
   place to paste a key".
2. Password: typed once, sealed in the browser to Office PC's runner key, used once to append a new Guildwise key to
   the server, then dropped. The screen says so before she types.
3. First contact: "The server says its fingerprint is SHA256:abc... If your hosting company shows a fingerprint, check
   it matches." **It matches / I can't check, continue**.
4. Panel: Guildwise shows the public key with **Copy** and step-by-step text, then **I pasted it, test the connection**.
5. Connection test, then the server probe (J3 step 3). If Docker is missing: "Will set up: install Docker, create
   /opt/shop, set up HTTPS for shop.example.com" with **Set it up** (one-time `deploy.prepare`, v2).

### J5. Reconnect from a new workstation (v2; detection in v1)
- The target card shows "Deploys from: **Old laptop** (offline 12 days)" or "**New PC** cannot sign in to the server".
  Button **Reconnect from this computer**: picks the current workstation, runs J3 step 2 (maybe the new PC already has
  the alias) or J4 (new key for this workstation). On success `DeployTargetUpdated {workstationId}`. Then: "Old laptop's
  Guildwise key is still allowed on the server. **Remove it** / Keep it". Remove deletes exactly the one line with that
  key's fingerprint (shown), after confirmation. Keys added by people are never offered for removal.

### J6. Move to a new server (v3)
- On a production target: **Move to a new server**. Steps: connect the new server (J4) -> probe (empty or partial) ->
  prepare (v2) -> copy settings (`.env` streamed server-to-server through the workstation, never displayed) -> copy
  the latest database backup and restore it -> deploy the same approved version to the new server and check it by
  address -> "Point shop.example.com to 203.0.113.9" with instructions and a live DNS check -> **Make the new server
  live**. The old target becomes **Standby (fallback)**, shown with "Retire" that only the Owner can press. Nothing is
  deleted on the old server.

### J7. Pieter: developer view
- Every screen has **Show technical details**: the structured steps as fields (argv, folders, env names, health
  spec), the generated `recipe.yaml` and scripts read-only with a diff against the approved version, the probe report
  as JSON, and **Edit scripts by hand** (marks the environment `custom`; the guided view shows "Edited by hand: shown as
  a script" and offers **Back to guided** which regenerates and so needs re-approval). Recipes written by DevOps/CEO
  (`aom recipe save`, section 10 of the front-door design) without a `setup.json` show as custom too, with **Scan with
  DevOps** to convert them.

### J8. Pieter's own adoption (first adopter, must not disrupt)
- UAT: the probe finds compose project `aom-uat` via container labels (`com.docker.compose.project.config_files` =
  `~/.config/aom-uat/docker-compose.yml`), services and published port 4700. The guided choice **Use aom-uat** compiles
  a script that rebuilds **only** `app`, from the approved commit's clean checkout, through an override file the
  script writes into the run directory (the owner's compose file is not edited):
  ```yaml
  # generated at deploy time in <run dir>, never in ~/.config/aom-uat
  services:
    app:
      build: ${AOM_DEPLOY_CHECKOUT}
      image: aom-uat-app:${AOM_DEPLOY_COMMIT}
  ```
  `docker compose -p aom-uat -f ~/.config/aom-uat/docker-compose.yml -f <override> up -d --build --no-deps app`.
  The "Will change" list states it plainly: "Today this copy is built from your main folder. After this, it is built
  from the approved version of each merge." (Owner question Q5.)
- Production: probe finds `/opt/app`, `image: ${GUILDWISE_IMAGE}`, current value `guildwise-hq:<sha>`, Caddy,
  `backups/`. The template "Image built here, shipped over SSH" reproduces today's manual procedure exactly (section
  4.3), so the first approved release is the same steps Pieter runs by hand now.

---

## 3. Screens (web, mobile first)

General rules: one question per screen, single column, sticky bottom bar (Back / primary action), step indicator
"Step 2 of 5", 44 px touch targets, cards instead of tables, technical text collapsed behind **Show technical details**.
Drafts autosave (`DeliverySetupDraftSaved`, debounced), so the wizard resumes on another device. Every probe and scan
result shows its age ("checked 3 minutes ago, **Check again**").

### 3.1 Run and test (replaces the text-box form in `RunSettings.tsx`)

**R0 Overview** (`RunStepsCard`)
- States: *Not set up* ("Guildwise does not know how to start this app yet. Card tests need this.") /
  *Scanning* (progress, "Cancel scan") / *Proposal waiting* ("DevOps has a suggestion: Review") / *Ready*
  ("Starts in 4 steps on any computer of this project. Last start: OK 2 h ago") / *Needs attention* ("The last start
  failed at **Install packages**: npm could not find package-lock.json. DevOps is fixing it" or "Review DevOps's fix").
- Actions: **Scan with DevOps**, **Edit steps**, **Test these steps**, overflow: *Show technical details*, *History*.
- Per-workstation plans that differ from the project plan are listed: "Office PC uses its own version (saved by DevOps
  after a failed start). **Use the project version here** / **Make this the project version**".

**R1 Steps editor** (`RunStepsEditor`)
- Two sections, in plain words: **Before starting** (setup steps) and **Parts of the app** (services).
- Each step is a card: icon + label ("Install packages", "Build", "Prepare the database", "Start the website", "Start a
  database (Docker)"), one line of what it does ("Runs `npm ci` in web/"), badge Found/Guessed/Unknown when it came from
  a scan, and **Edit** / drag handle / remove.
- **Add a step** opens a picker of templates (section 4.1). Template forms ask only what the template needs:
  - "Which folder?" (select from the repo folders the scan found, else text with "." = top folder);
  - "Which port does it use?" (number, "Usually 3000 for this kind of app"), "Is the port set by an environment
    variable?" (yes: name, prefilled `PORT`);
  - "How do we know it is ready?" radio: *The page opens* (path, default `/`) / *The port answers* / *A line appears in
    its output* (text) / *Just wait* (seconds);
  - "Start after" (chips of the other parts);
  - "Settings file on the computer" (path picker hint, optional; never uploaded);
  - "Runs only" when: *Every start* / *Only the first start* / *When these files change* (pattern, advanced).
- Validation inline in plain words, using `validateRunPlan` messages rewritten through a message map
  (`"cwd must stay inside the repository"` -> "The folder must be inside the project").
- Developer toggle per card: the raw `cmd` (argv editor with `formatCommandLine`), `env`, `stopCmd`, `docker`,
  timeouts. The old free-text "Run instructions" and "Build guide" move to *Show technical details > Notes for DevOps*.
- Bottom bar: **Test these steps** (saves as a draft plan and starts a manual run environment on a chosen workstation)
  and **Use these steps** (saves the project plan).

**R2 Scan review** (shared component `ProposalReview`, also used for deploys)
- Header: "DevOps read web/package.json, docker-compose.yml and BUILD.md on Office PC." (evidence list collapsible).
- Each proposed item: accept (default for Found), edit, or drop. Unknowns are required questions at the top
  ("2 questions before you can use this").
- Notes from DevOps shown as a callout (plain text, never executed).
- Actions: **Use these steps** / **Test first** / **Dismiss**.
- Errors: "The scan did not finish (DevOps stopped after 30 minutes). **Try again** or **Set up myself**." /
  "Office PC is offline. Scans run on a computer with the project's code. **Choose another computer**." /
  "Guildwise on Office PC is too old for scans. **How to update**." (capability check before starting).

### 3.2 Phases and deploys (replaces the add-target form and extends `DeliveryPanel.tsx`)

**D0 Deploys overview** (`DeploySetupOverview`)
- One card per environment, in order (e.g. *Test copy*, *Live site*), each showing: where (target name + "On Office PC"
  or "Server prod-server"), **Deploys from: Office PC** with a reachability dot (Reachable 5 min ago / Cannot sign
  in / Offline / Never checked), **Production** badge if set, when it updates, approval state ("Waiting for your
  approval", "Approved version 3", "Changed since approval: needs your approval"), last deploy result.
- Empty state: "Your app is not deployed anywhere yet. **Set up deploys**" (+ "Let DevOps look at it first").
- Card actions: **Edit**, **Check connection**, **Reconnect** (when not reachable), overflow *Move to a new server*
  (v3), *Show technical details*.
- The existing **Delivery mode** select is hidden in the guided view: saving the first approved setup offers "Use this
  setup for deploys from now on" (`DeliveryModeSet recipe`).

**D1 Where** ("Where should <env label> run?")
- **On this computer** (lists the workstation the user is on, or a select of the project's workstations) /
  **On my own server (VPS)** / **Not sure: let DevOps look** (starts a deploy scan).
- Env label question first time: "What is this copy for?" *Testing before going live (test copy)* / *The live site
  (production)*. The latter ticks Production.

**D2a This computer**: probe progress ("Looking at Docker on Office PC...") then:
- Found stacks as cards: name, parts, address, "started 3 days ago", the compose file path in technical details.
  **Use this one** / **Start a new copy** (uses the repo's compose file or the run steps; section 4.2).
- Not found: "Docker is not installed on Office PC." with a link to install instructions and **Check again** (Guildwise
  does not install Docker on a desktop).
- Docker present but the user is not allowed: "Your user on Office PC can't use Docker. On Linux, an admin adds you to
  the docker group." (`docker_permission`).

**D2b Server sign-in** (see J3/J4): list of detected hosts with state chips: *Can sign in* / *Asks for a password*
(BatchMode refused) / *Server not reachable* / *Server identity changed* (blocking, see 6.4). Primary: **Use the
sign-in this computer already has**. Secondary: **Connect a different server** (v2: J4).

**D3 What we found** (`FoundChanges`): three groups from `planChanges`:
- **Found and will reuse** (green): folders, stacks, volumes, proxy and its domains, backups, current version.
- **Each update will** (blue): the ordered list of compiled steps in plain words, with "(skipped if already done)".
- **Will not touch** (grey): every found thing the setup does not change, listed by name.
- **Needs your answer** (amber): unknowns ("Which part is your app? *app* / *worker* / *web*").
- Production checkbox here and on D0: **This is the live site your customers use (production)** with the explainer
  "Production is never used for tests, and every release needs your approval."

**D4 When** (defaults per R7, described in words; changing gate or trigger beyond the offered options is in technical
details).

**D5 Secrets**: names only; per name **Set on Office PC** (existing sealed `deploy.secret.set`), state *Set* / *Missing*,
never a value. Also "Use the settings file already on the server" for remote `.env` (the default for adopted servers:
nothing is copied).

**D6 Review and approve** (`SetupReview`): plain summary, the change list, lint in plain words (map of `LintItem.code`
to copy), **Try it without changing anything** (dry run; for non-production also **Try a real deploy**, existing trial
rules), **Save** (compile + `recipe.write`), then the existing approval card **Approve this version** (Owner only;
others see "Waiting for the Owner's approval"). Technical details: generated files and the raw diff from the runner.

**States and errors common to D-screens**
| Situation | Copy | Action |
|---|---|---|
| Deploying workstation offline | "Office PC is offline. It is the computer that deploys this." | Choose another computer / Wait |
| Runner without `deploy-setup:1` | "Guildwise on Office PC needs an update for guided setup." | How to update; developer view still works |
| Probe timeout | "Office PC could not finish checking in 60 seconds." | Check again |
| Hand-edited env | "This part was edited by hand, so it is shown as a script." | Back to guided (needs approval) |
| Recipe changed outside the guided view | "Someone changed the deploy files. Review and approve, or go back to the approved version." | Review |
| Save pending (vault write queued) | "Saving to the project's files on Office PC..." | - |

---

## 4. Templates (structured steps) and the compilers

### 4.1 Run step templates (compile to `RunSetupStep` / `RunService`)

`packages/shared/src/runs/templates.ts`. Each template has a form schema and a pure `toPlanItem`. The plan item keeps
`template` and `label` (new optional fields) so the UI can show it again as a template.

| Template | Asks | Produces |
|---|---|---|
| `install_packages` | folder, package manager (detected: npm/pnpm/yarn/pip/poetry/bundle/go) | setup step, `when: changed:<lockfile>` |
| `build` | folder, command (prefilled from scripts.build) | setup step |
| `prepare_db` | folder, command (migrate) | setup step, `when: always` |
| `web_app` | folder, command, port + env var, ready check, start after | service |
| `docker_service` | image (postgres:16 / redis:7 / mysql:8 / custom), port, env names | service with `docker: true`, `cmd: docker run --rm --name aom-${env}-<name> -p ${port}:<p> <image>` |
| `compose_stack` | compose file in repo, services | service `docker: true`, `cmd: docker compose -p aom-run-${envShort} up`, `stopCmd: ... down` (own throwaway project name, never an adopted stack) |
| `custom` | argv | step or service as today |

### 4.2 Deploy step templates (`packages/shared/src/delivery/setup.ts`)

```ts
DeliverySetup = {
  version: 1,
  generator: string,                 // compiler version that produced the scripts, e.g. "setup-1.0"
  environments: SetupEnv[],
}
SetupEnv = {
  name: EnvName, label: string,      // "uat", "Test copy"
  target: string,                    // deploy_targets.name
  mode: 'guided' | 'custom',         // custom: script is hand-written, compiler leaves it alone
  hosting: 'this_computer' | 'ssh',
  app: {                             // what was adopted (from the probe), all values validated to safe charsets
    composeFile: AbsPathOrTilde,     // local, or remote absolute path
    composeProject?: string,
    service: ServiceName,            // the only service that is rebuilt/restarted
    imageName: ImageName,            // e.g. guildwise-hq / aom-uat-app
    imageVar?: EnvVarName,           // remote: the .env key that pins the image (GUILDWISE_IMAGE)
    appUrl: Url,
  },
  steps: SetupStep[],                // ordered, see table
  health: RunHealth, healthTimeoutSec: number, rollback: boolean,
  trigger: Trigger[], releasedBy, gate,   // filled with the safe defaults
  secrets: SecretName[], envFile?: string,
  timeoutSec: number,
}
```

| Step `kind` | Plain words | Generated shell (summary) | Idempotent / non-destructive by |
|---|---|---|---|
| `lock` (always first, implicit) | - | `flock -n` on `${XDG_RUNTIME_DIR:-/tmp}/aom-deploy-<project>-<env>.lock` | - |
| `already_deployed` (implicit) | "Skip if this version is already live and healthy" | compare running image tag of `app.service` with the commit + health probe; print `AOM-DEPLOY` and exit 0 | no-op on rerun |
| `db_backup` | "Back up the database to <dir>" | `docker compose ... exec -T <dbService> pg_dump -U "$DB_USER" "$DB_NAME" \| gzip > <dir>/<env>-before-<sha>-<ts>.sql.gz`; fail if the file is under 1 KB; keep the newest N | new file only; never deletes except beyond N (N from setup, default 20, 0 = keep all) |
| `env_backup` (remote) | "Save a copy of the settings file" | `cp -p .env .env.bak-before-<sha>` (no overwrite if it exists) | copy only |
| `build_image_local` | "Build the app from the approved version" | `docker build -t <image>:<sha> "$AOM_DEPLOY_CHECKOUT"` (skip if the tag exists) | new tag only |
| `ship_image_ssh` | "Copy the app to the server" | skip if `ssh host docker image inspect <image>:<sha>`; else `docker save \| gzip \| ssh host 'gunzip \| docker load'` | adds an image |
| `set_image_var` (remote) | "Switch the server to the new version" | rewrite exactly one line `<VAR>=...` in `.env` via a temp file + `mv` (append if missing); record the old value in the run dir | backup from `env_backup` |
| `compose_up_local` | "Restart only <service> on this computer" | override file (J8) + `docker compose -p P -f F -f O up -d --build --no-deps <service>` | `--no-deps`, never `down`/`-v`/`--remove-orphans` |
| `compose_up_remote` | "Restart only <service> on the server" | `ssh host 'cd <dir> && docker compose up -d --no-deps <service>'` | same |
| `wait_healthy` (implicit when `health` is set) | "Check the site works" | poll health until `healthTimeoutSec`; on failure and `rollback`: restore the previous image var (remote) or previous tag (local), `up -d --no-deps` again, exit 1 "rolled back to <old>" | DB is never rolled back automatically; the backup path is printed |
| `compose_run` (v2) | "Run database updates" | `docker compose run --rm <service> <argv>` | as the app does |
| `custom_command` (developer) | the label the developer gives | the argv, quoted | developer's responsibility; shown as such in the change list |

**Compiler** `compileSetup(setup): {files: {path, mode, content}[], recipe: RecipeInput}`:
- Pure and deterministic (byte-identical output for the same input and `generator`), unit-tested with golden files.
- All user values are validated by zod to strict charsets (paths `^[A-Za-z0-9._/~-]+$`, alias
  `^[A-Za-z0-9._-]+$`, image `^[a-z0-9][a-z0-9._/-]*$`, env var names) **and** single-quoted with one `shq()`
  function. Remote snippets are sent as `ssh "$HOST" bash -s -- <args> <<'AOM_REMOTE'` heredocs with positional args,
  so no value is interpolated into a remote command line unquoted.
- Every script follows the script contract of front-door 9.2: `set -euo pipefail`, lock, readiness wait, safe rerun,
  `AOM_DEPLOY_DRY_RUN=1` prints each step as "would ..." and runs only the read-only checks, final `AOM-DEPLOY {json}`.
- Remote steps use `${AOM_DEPLOY_SSH:-ssh}` so v2 can pass a dedicated key without recompiling.
- Header comment: `# Generated by Guildwise <generator> from setup.json (env <name>). Edit in the guided view, or switch
  this environment to "custom" first.`
- `generator` is stored in `setup.json`; a newer compiler never silently rewrites approved scripts. When a newer
  generator exists the overview says "An improved version of these steps is available" (optional regenerate ->
  re-approval).
- `recipe.yaml` gets the environment fields from the setup (target, trigger, health, secrets, gate, `docker: true`,
  `script: scripts/<env>.sh`). `mode: custom` envs keep their existing `script` entry untouched.

**Hand-edit detection:** on `recipe.inspected`, the server compiles the stored `setup.json` and compares each guided
env's script sha256 with the inspected file list. A mismatch adds the env to `handEdited[]` (shown in the UI, lint
`warn` code `hand_edited`). Approval semantics are unchanged: whatever bytes are in `delivery/` are what is approved.

### 4.3 The first-adopter production script (what the compiler must reproduce)

Steps for `production` on `prod-server`: lock -> already_deployed -> `db_backup` (remote, `postgres` service in
`/opt/app`, to `/opt/app/backups`) -> `env_backup` (`.env.bak-before-<sha>`) -> `build_image_local`
(`guildwise-hq:<sha>` from the clean checkout) -> `ship_image_ssh` -> `set_image_var GUILDWISE_IMAGE` ->
`compose_up_remote app` -> `wait_healthy https://<domain>/ready` (exact path from the probe/scan) -> rollback on failure.

---

## 5. "Scan with DevOps" (both sides)

### 5.1 Invocation
- Web: `POST /api/projects/:id/scan {area:'run'|'deploy', workstationId?, targetIds?}` -> server picks the workstation
  (run: the chosen one or `workstationForVault`-like choice among members with the repos; deploy: the target's
  deploying workstation), checks capability `setup-scan:1`, and files a DevOps request through the existing path
  (`DevOpsRequested`) with context `{requestKind:'run_scan'|'deploy_scan', projectId, projectKey, targetIds}`.
  Response `{requestId}`; the UI follows the request status over the existing websocket invalidation.
- One open scan per (project, area); a second press shows the running one.

### 5.2 What DevOps does (brief + tools)
- Brief addendum (server `devops` brief builder, keyed on `requestKind`): "This is a READ-ONLY scan. Do not start,
  stop, build, install or edit anything. Read the repository and the run/deploy facts. Use `aom deploy probe` for
  target facts. Finish with `aom setup propose`."
- Reads: repository files (BUILD.md, README, package manifests and lockfiles, Dockerfile, compose files, Procfile,
  Makefile, `.env.example`, CI config, `deploy/`), the current run plan(s) and recipe, run instructions, probe reports.
- Tools: `aom deploy probe --target <name>|--local|--ssh-hosts` (IPC -> the runner runs the fixed probe locally and
  reports `DeployTargetProbed` to the server; DevOps gets the redacted JSON). DevOps settings for scan kinds
  (`buildDevopsSettings`) deny `Bash(docker compose up*)`, `down`, `rm`, `Bash(ssh:*)`, `Bash(scp:*)`, writes outside
  its scratch dir; allow `aom deploy probe`, `aom setup propose`. Guards are defense in depth; the authority for
  "Found" is the deterministic probe.
- Output: `aom setup propose --area run|deploy --file <json>` (IPC `setup.propose`) validated by
  `SetupProposalSchema`:
  ```ts
  SetupProposal = {
    area: 'run' | 'deploy',
    run?: RunPlan,                         // area run
    deploy?: DeliverySetup,                // area deploy
    items: { path: string,                 // JSON pointer into run/deploy, e.g. "/services/0/ports/0/default"
             confidence: 'found' | 'guessed' | 'unknown',
             evidence?: { file?: string, line?: number, probe?: string }[],
             note?: string }[],
    questions: { path: string, question: string, options?: string[], default?: string }[],
    secretsNeeded: SecretName[],
    notes: string,                         // max 4000, shown as text only
  }
  ```
  Invalid proposals are refused on the IPC call with the zod error so DevOps can fix and resubmit within the shift.
- Server: `SetupProposalSubmitted {proposalId, projectId, area, requestId, workstationId, proposal}`; the DevOps
  request completes as usual. Desk notice "DevOps has a suggestion for <project> run steps".

### 5.3 Review and confirm
- `ProposalReview` (3.1 R2) merges the proposal over the current plan/setup, highlighting differences. Unknown items
  block **Use** until answered. Confirming:
  - run: `PUT /api/projects/:id/run-plan {plan, source:'scan', proposalId}` -> `RunPlanSaved {source:'scan',
    workstationId:null}` + `SetupProposalResolved {accepted}`;
  - deploy: the proposal becomes the draft (`DeliverySetupDraftSaved`), and the wizard opens at D3 with the probe
    results, so the user still sees Found / Will change before saving.
- Dismiss: `SetupProposalResolved {dismissed}`.

---

## 6. Detection: the non-destructive probe

### 6.1 Runner command `deploy.probe` (durable, result in `command.result`)
```ts
DeployProbePayload = {
  projectId: uuid, targetId?: uuid,
  scope: 'local' | 'ssh_hosts' | 'ssh_target',
  host?: SshAlias,                  // ssh_target
  hints?: { composeFiles?: string[], dirs?: string[], urls?: string[] }  // from setup/scan, bounded
}
DeployProbeResult = { ok: true, report: ProbeReport } | { ok: false, error: ProbeError, detail?: string }
ProbeError = 'docker_missing' | 'docker_permission' | 'ssh_auth' | 'ssh_unreachable' | 'ssh_host_key_changed'
           | 'ssh_host_key_unknown' | 'timeout' | 'unsupported_os'
```
Bounded: 60 s total, each command 10 s, report under 64 KB.

### 6.2 What is probed (fixed commands only)
- **local**: `docker version --format json`, `docker compose version`, `docker compose ls --all --format json`,
  `docker ps --all --format json` (+ labels `com.docker.compose.project`, `.service`, `.project.config_files`,
  `.project.working_dir`), published ports, images for running containers, `docker volume ls`; parse each found compose
  file locally (YAML) into **structure only**: service names, `image:`/`build:` (context path), ports, volume names,
  `env_file` paths, names of `${VARS}` referenced (never `environment:` values); HTTP GET of found URLs on
  `/ready`, `/health`, `/api/health`, `/` (status only); backup dirs next to the compose file (count, newest file name
  and date); free disk.
- **ssh_hosts**: parse `ssh -G <alias>` for each `Host` entry without wildcards in `~/.ssh/config` (alias, hostname,
  user, port, whether an identity is configured: yes/no, never the key path content); then for each (max 10, in
  parallel) `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes <alias> true`, classify exit/stderr
  into reachable / asks_password / unreachable / host_key_unknown / host_key_changed. The runner reads
  `~/.ssh/config` text; it does not open key files or `known_hosts` beyond what `ssh` itself does.
- **ssh_target**: one `ssh -o BatchMode=yes <alias> sh -s` with a fixed read-only probe script from the runner
  (`apps/runner/src/delivery/probe-remote.sh`, bundled, versioned): `uname -sm`, `id -u`, `docker version`,
  `docker compose ls --format json`, `docker ps --format json` with labels, `ls -la` of hinted dirs and of
  `/opt/*/docker-compose.y*ml` and `/srv/*/docker-compose.y*ml`. Found compose files are sent over the ssh channel to
  the runner only; the runner extracts the structure (as for local) and discards the text, which is never logged and
  never leaves the workstation. For `.env` in a
  found compose dir: only key names, plus the value of keys referenced by an `image:` (e.g. `GUILDWISE_IMAGE`) after
  checking it matches the image charset; proxies: running caddy/nginx/traefik containers or systemd units, Caddyfile /
  nginx `server_name` site addresses only; backups dir listing (names, sizes, dates); `df -h` of the app dir;
  ports 80/443 listeners.
- Every probe writes nothing anywhere (no temp files on the server; the local runner writes only its own log).

### 6.3 Found / Will change (`planChanges` in `packages/shared/src/delivery/changes.ts`)
Pure: `planChanges(setup: DeliverySetup, report: ProbeReport): ChangeItem[]` with
`ChangeItem {group:'reuse'|'each_deploy'|'untouched'|'setup_once'|'question', text, ref?}`. Rules: everything in the
report that the setup references -> `reuse`; every compiled step -> `each_deploy` in plain words; every other found
container, volume, folder, proxy site -> `untouched`; anything the setup needs that is missing -> `setup_once` (v1:
shown as a blocker with instructions; v2: actionable via `deploy.prepare`); unresolved references -> `question`.
The same function feeds D3, D6 and the approval card.

### 6.4 SSH safety rules (enforced in runner code)
- `StrictHostKeyChecking=yes` for existing aliases (the user's `known_hosts`); a changed host key is a hard stop with
  copy "The server's identity changed. This can mean it was reinstalled, or someone is in between. Guildwise will not
  connect. If you reinstalled it, remove the old entry with `ssh-keygen -R <host>` and check again." No UI override.
- New connections (v2) use the runner's own `known_hosts` (`~/.aom-runner/secrets/deploy_known_hosts`), with
  first-contact fingerprint confirmation in the UI.
- Never edit `~/.ssh/config`. If the user wants an alias for a new server (v2), the UI shows the exact block to add and
  an **Add it for me** button that appends it (with a dated backup copy of the file) only after confirmation.

---

## 7. Data model, events, API, runner protocol

All additions are new events or new optional fields; projections stay replay-safe. Old runners keep working: new
commands go only to runners announcing the new capabilities; payload extensions are optional fields zod strips on old
runners.

### 7.1 Events (`packages/shared/src/events/*`)
| Event | New / changed | Payload | Projection |
|---|---|---|---|
| `RunPlanSaved` | changed (optional fields) | `source?: 'devops'|'owner'|'scan'` (absent = devops), `workstationId` becomes `Id.nullable()` (null = project-wide), `savedBy?: Id`, `proposalId?: Id` | `run_plans`: `workstation_id` nullable, `source text NOT NULL DEFAULT 'devops'`, unique active index on `(project_id, coalesce(workstation_id, '00000000-...'))` |
| `RunPlanSchema` items | changed (optional fields) | `label?: string`, `template?: string` on setup steps and services | in the plan JSON |
| `SetupProposalSubmitted` | new | `{proposalId, projectId, area, requestId, workstationId, proposal}` | `setup_proposals` |
| `SetupProposalResolved` | new | `{proposalId, outcome:'accepted'|'dismissed', by}` | `setup_proposals.status` |
| `DeliverySetupDraftSaved` | new | `{projectId, setup, by}` (latest wins) | `delivery_setup_drafts (project_id PK, setup jsonb, updated_by, updated_at)` |
| `DeliverySetupPublished` | new | `{projectId, setupHash, commandId, generator, by}` (audit: who generated which files) | `delivery_recipes.last_publish jsonb` |
| `DeliveryRecipeObserved` | changed (optional) | `setup?: DeliverySetup`, `handEdited?: string[]` | `delivery_recipes.setup jsonb`, `hand_edited text[]` |
| `DeployTargetAdded/Updated` | changed (optional) | `workstationId` now allowed for `local_docker` ("this computer"); `label?: string`; v3 `role?: 'active'|'standby'|'retired'` | `deploy_targets` new nullable columns |
| `DeployTargetProbed` | new | `{probeId, projectId, targetId|null, workstationId, scope, report|error, at}` | `deploy_probes` (latest per target+workstation+scope) |
| `DeployTargetConnectionChecked` | new | `{targetId, workstationId, state, method:'existing_alias'|'deploy_key', host, hostKeyFingerprint?, keyFingerprint?, detail?, at}` | `deploy_target_connections (target_id, workstation_id) PK` |
| v2 `DeployTargetConnected`, `DeployKeyRevoked`, `DeployTargetPrepared` | new | key fingerprints (public), actions done, by | same table + audit |
| v3 `DeployTargetMoveStarted/StepDone/Completed` | new | move id, from/to targets, steps | `deploy_target_moves` |

Migrations: one numbered file (e.g. `apps/server/migrations/22xx_guided_setup.sql`) for the new tables/columns; data
migration not needed (absent `source` = `devops`).

### 7.2 Server
- `apps/server/src/commands/runs.ts`: `saveOwnerRunPlan` (validate with `validateRunPlan`, append `RunPlanSaved`
  `source:'owner'|'scan'`); `findReplay` falls back to the project-wide plan and sends `buildHash: null` for owner/scan
  plans; `staleCheck`/`markPlanStale` skip owner/scan plans; `applyRunReplayFailed` on an owner plan keeps it active but
  flags `last_failure` and files the DevOps repair request (DevOps's fix lands as a per-workstation `devops` plan, shown
  as "differs from the project version", Q3).
- `apps/server/src/commands/deploy-targets.ts`: `checkShape` allows `workstationId` (not `host`) on `local_docker`;
  production toggle validation unchanged (`checkTesting`).
- New `apps/server/src/delivery/setup.ts`: drafts, preview (`compileSetup` + lint + `planChanges` against the latest
  probe), publish (enqueue `recipe.write` to the vault's workstation, append `DeliverySetupPublished`), hand-edit
  detection in `observeRecipe`.
- New `apps/server/src/delivery/probes.ts`: enqueue `deploy.probe`, apply results, connection states, a stale-after
  (1 h) rule for showing "checked x ago"; a probe is re-requested when a deploy fails with an ssh error.
- `apps/server/src/delivery/rpc.ts`: IPC `setup.propose`, `deploy.probe` (DevOps in a scan request, same shift rules as
  `recipe.save`).
- DevOps brief: scan kinds (`requestKind` enum gains `run_scan`, `deploy_scan`, optional field, widening).

### 7.3 API (`packages/shared/src/api/*`, routes in `apps/server/src/routes/runs.ts`, `delivery.ts`)
| Method | Path | Body / result |
|---|---|---|
| GET | `/api/projects/:id/run-plan` | `{projectPlan, workstationPlans[], lastFailure?}` |
| PUT | `/api/projects/:id/run-plan` | `{plan, scope:'project'|{workstationId}, source:'owner'|'scan', proposalId?}` |
| POST | `/api/projects/:id/run-plan/test` | `{plan?, workstationId}` -> starts a manual env (saves draft first) |
| POST | `/api/projects/:id/scan` | `{area, workstationId?, targetIds?}` -> `{requestId}` |
| GET | `/api/projects/:id/proposals?area=` | open proposals |
| POST | `/api/setup-proposals/:id/resolve` | `{outcome}` |
| GET / PUT | `/api/projects/:id/delivery/setup` | draft |
| POST | `/api/projects/:id/delivery/setup/preview` | `{files[], recipe, lint[], changes[]}` (no write) |
| POST | `/api/projects/:id/delivery/setup/publish` | `{setupHash}` (must equal the previewed one) -> `{commandId}` |
| POST | `/api/deploy-targets/:id/probe` | `{workstationId?}` -> `{commandId}`; GET returns the latest report + connection |
| POST | `/api/workstations/:id/ssh-hosts/probe` | -> `{commandId}`; GET latest |
| PATCH | `/api/deploy-targets/:id` | existing; UI now sends `production`, `workstationId` for local |
| v2 POST | `/api/deploy-targets/:id/connect` | `{method:'password'|'keyfile'|'panel', address, user, port, sealed?}` |
| v2 POST | `/api/deploy-targets/:id/revoke-key` | `{keyFingerprint}` |
| v2 POST | `/api/deploy-targets/:id/prepare` | `{actions[], changesHash}` |
| v3 POST | `/api/deploy-targets/:id/move` | `{toTargetId}` + step endpoints |

Permissions: editing setup/run plan = project owner role (as `canEdit` today); approving = the Owner (unchanged
`canApprove`); probes = project members (read-only); connect/prepare/revoke = project owner role plus the deploying
workstation's user.

### 7.4 Runner protocol (`packages/shared/src/protocol/runner.ts`, `delivery/protocol.ts`)
- Capabilities: `deploy-setup:1` (`deploy.probe`, `recipe.write`), `setup-scan:1` (IPC `setup.propose`,
  `deploy.probe` IPC), v2 `deploy-connect:1`.
- `recipe.write {projectId, vault, files:{path, mode, content}[], commitMessage, expectedSetupHash}`: replaces
  `<folder>/delivery/` in one commit using the existing `apps/runner/src/vaults/delivery.ts` writer (the one behind
  `aom recipe save`), refuses any path outside `delivery/` or any file the secret scan flags, then reports
  `recipe.inspected` as after `aom recipe save`. Not an envelope command (no secrets in it).
- `deploy.probe` as in 6.1. Implementation `apps/runner/src/delivery/probe.ts` + `probe-remote.sh`; tests use fake
  `docker`/`ssh` binaries on PATH.
- v2 `deploy.connect` (in `ENVELOPE_COMMANDS`: the sealed password; payload emptied once answered, expires in 10 min):
  generate `ed25519` key in `~/.aom-runner/keys/deploy/<targetId>` (0600), connect with `SSH_ASKPASS` +
  `SSH_ASKPASS_REQUIRE=force` pointing at a runner helper that reads the password from a pipe (OpenSSH >= 8.4; else
  "Use the copy-paste option"), append the public key to `~/.ssh/authorized_keys` only if `grep -qxF` finds it absent,
  test with the new key in BatchMode, report fingerprints. `deploy.exec` then exports `AOM_DEPLOY_SSH="ssh -i <key>
  -o IdentitiesOnly=yes -o UserKnownHostsFile=<runner known_hosts>"` and `AOM_DEPLOY_HOST`.
- v2 `deploy.prepare {targetId, actions[]}` with a closed action list (`install_docker` via the distro package,
  `create_dir`, `write_compose_from_repo`, `caddy_site` (append a site block to an existing Caddyfile with a dated backup
  and `caddy validate` before reload, or start a Caddy container if 80/443 are free)); each idempotent, each logged.
- `deploy.exec`: unchanged in v1.

---

## 8. Security

- **Approval integrity:** the UI never runs anything a deploy could not run before. It writes files into `delivery/`
  (new hash -> `DeliveryRecipeDrifted`/observed -> Owner approval of exactly that hash). `publish` takes the previewed
  `setupHash`; the approval card shows the plain-language change list *and* the raw diff the runner renders. Generated
  scripts are as auditable as hand-written ones. The compiler version is recorded.
- **Secrets never shown back:** names in `setup.json`/recipe; values via the existing sealed `deploy.secret.set`; probe
  reports carry key names only (and image refs after a charset check); the probe's raw remote output never leaves the
  runner. Lint `secret_in_file` still runs on generated files.
- **Keys never read:** the runner calls `ssh`; it parses `~/.ssh/config` text and `ssh -G` output, never opens private
  key files; deploy keys live in the runner's data dir, shown as public key + fingerprint only.
- **No silent edits:** `~/.ssh/config`, existing keys, the server's `authorized_keys`, Caddyfiles: append-only, after an
  explicit confirmation showing the exact text, with a dated backup where a file is changed. Keys are never removed
  except a Guildwise-created key by its fingerprint, after confirmation.
- **Password:** sealed in the browser to the runner's key (existing envelope pattern), used once in memory, never logged,
  never stored, command payload emptied after the answer.
- **DevOps in scans:** read-only brief, denied write tools, probes through fixed code; its proposal is data (schema-
  checked), `notes` rendered as text; nothing it proposes runs before the user confirms and (for deploys) the Owner
  approves.
- **Production:** the checkbox drives existing rules (never tested, lint `production_no_gate`), plus: unticking
  production requires the project owner and triggers a re-lint; the compiled production gate always includes
  `approvers:['owner']`.
- **High-risk items:** remote command injection (mitigated by charset validation + `shq` + positional heredoc args,
  fuzz tests); rollback restoring an incompatible DB (no automatic DB rollback; backup path printed); the probe parsing
  hostile compose files (YAML size limits, no anchors expansion bombs: `yaml` with `maxAliasCount`).

---

## 9. Phased delivery

Sizes in focused developer-days (one person, including tests).

### v1a: run steps and the production checkbox (about 6-8 days)
- Production checkbox in the add/edit target form and as a badge on the target card; `workstationId` allowed on
  `local_docker`; target card shows "Deploys from <workstation>" + online state (no ssh check yet). (1 day)
- Run plan: optional `label`/`template`, `source`, project-wide plan, `findReplay` fallback, owner save API, the new
  `RunStepsCard`/`RunStepsEditor` with templates, plain-language validation, developer raw view; old declared-services
  form moved into technical details. (4 days)
- Run scan: `requestKind:'run_scan'`, brief, `aom setup propose`, `SetupProposalSubmitted/Resolved`, `ProposalReview`.
  (2-3 days)

### v1b: guided deploy for "this computer" and "VPS with existing sign-in" (about 12-15 days)
- `DeliverySetup` schema, `compileSetup` with the v1 step kinds, golden tests for Pieter's UAT and production. (4 days)
- `recipe.write` runner command, server publish/preview/hand-edit detection, drafts. (2-3 days)
- `deploy.probe` (local, ssh_hosts, ssh_target) + `planChanges` + connection states. (3-4 days)
- Wizard D0-D6 and overview; deploy scan (`deploy_scan`) reusing `ProposalReview`. (3-4 days)
- Adoption of Pieter's UAT and production, side by side with the current manual procedure: dry run first, then a UAT
  real run, then production with approval. (1 day)
- Outcome: R1, R2, R3, R5, R6, R7, R8 (existing sign-in part) and R10's "which workstation, can it reach" are met.

### v2: guided connect, dedicated keys, reconnect, provisioning (about 10-13 days)
- `deploy.connect` (password once via askpass, key file, panel copy-paste), runner known_hosts with fingerprint
  confirmation, optional dedicated key for existing aliases, `AOM_DEPLOY_SSH` in `deploy.exec`. (4-5 days)
- Reconnect from a new workstation, revoke Guildwise keys, scheduled reachability checks (daily + after failures).
  (2-3 days)
- `deploy.prepare`: Docker, folders, compose from repo, Caddy + HTTPS; `compose_run` step for migrations. (4-5 days)
- Outcome: R4 (guided VPS), R8 (dedicated key), R9, R10 (reconnect).

### v3: move to a new server (about 6-8 days)
- Move wizard: backup/restore, env carry-over, same-version deploy and check, DNS instructions and check, standby old
  target, retire. Outcome: R10 (moves).

### Test plan
- **Shared (vitest):** template -> plan item; `compileSetup` golden files (UAT adopt, production ship-over-ssh,
  this-computer new stack), byte determinism, quoting/charset fuzz (values with spaces, quotes, `$()`, newlines must be
  refused or quoted), every generated script passes `bash -n` (and `shellcheck` when available), dry-run branch present
  in every step; `planChanges` cases (adopted stack, extra containers untouched, missing Docker, unknown service);
  proposal schema and pointer validation; recipe lint on generated output (no errors for the defaults).
- **Runner (vitest):** `deploy.probe` with fake `docker`/`ssh` on PATH (compose ls/ps JSON fixtures, a compose file
  with secrets in `environment:` must not leak into the report, `ssh -G` parsing, BatchMode classification of stderr
  for each error kind), the remote probe script run locally in a temp root, `recipe.write` (modes, single commit,
  refuses `../` and secret-flagged files), and an exec test running a generated UAT script against fake docker in
  dry-run and real mode (only `app` restarted, never `down`).
- **Server (vitest, own DB per card):** owner plan save + project-wide fallback + no staleness on settings/BUILD.md
  change + replay failure path; `setup.propose` validation and events; publish -> `recipe.write` -> observed ->
  approve -> deploy uses the approved hash; hand-edit detection; capability gating (old runner: no scan/probe offered,
  developer view still works); replay of all new events from scratch equals the live projection (`runs-replay` style);
  `local_docker` with a workstation picks that workstation in `deployWorkstation`.
- **Web (vitest + testing-library):** RunStepsEditor templates and validation copy, ProposalReview (unknowns block
  Use), wizard state machine D0-D6 with mocked probe results, mobile viewport snapshots (360 px), production checkbox
  wiring, error states table of 3.2.
- **E2E (Playwright, `e2e/`):** "this computer" with a real throwaway compose stack: start it, run the wizard, adopt,
  deploy, assert the IDs of the non-app containers and the volume are unchanged; "VPS" with an `sshd` + Docker-in-Docker
  container reachable through a test ssh alias: probe, dry run, real deploy, a failing health check triggers rollback
  and the old image is live again; a run scan with a stubbed DevOps shift that submits a fixture proposal.
- **Manual first-adopter checklist:** Pieter's UAT and production dry runs compared line by line with the manual
  procedure before the first real release.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Generated shell has a quoting bug that becomes injection on the server | Strict charsets at the schema, one `shq`, positional heredoc args, fuzz tests, `bash -n`/shellcheck in CI |
| Adoption misidentifies the app service and restarts the database | `--no-deps`, single named service, "Will not touch" list shown before saving, dry run required before the first real deploy of a guided env (UI enforces "Try it" once per new setup hash) |
| Run plan "project-wide" breaks on a workstation with different paths (env files) | `envFile` stays per workstation-overridable; a failed replay creates a per-workstation DevOps plan, not a project change |
| Owner plan never refreshed after the app changes | a failed start flags it; scan can be re-run; overview shows the plan's age |
| Compose override semantics differ across Compose versions | probe records `docker compose version`; compiler requires v2; e2e covers the override |
| Vault write races (another writer edits `delivery/` meanwhile) | `recipe.write` replaces the folder in one commit; any change still needs approval; publish compares `expectedSetupHash` |
| Local vault on another workstation than the deploying one | existing refusal in `deployWorkstation`; the wizard detects it and explains "Give the project a shared vault" |
| `local_docker` with a workstation changes integration-test targeting | `TargetTesting` and test-environment code paths treat `workstation_id` on local targets as "only this one"; covered by server tests |

---

## 11. Files to create / modify

Create:
- `packages/shared/src/runs/templates.ts`, `packages/shared/src/delivery/setup.ts` (schema + `compileSetup`),
  `packages/shared/src/delivery/changes.ts` (`planChanges`), `packages/shared/src/delivery/probe.ts` (probe schemas),
  `packages/shared/src/setup/proposal.ts`, `packages/shared/src/events/setup.ts`
- `apps/server/src/delivery/setup.ts`, `apps/server/src/delivery/probes.ts`, `apps/server/src/commands/setup-proposals.ts`,
  `apps/server/migrations/22xx_guided_setup.sql`
- `apps/runner/src/delivery/probe.ts`, `apps/runner/src/delivery/probe-remote.sh`, `apps/runner/src/delivery/write.ts`
  (wraps `vaults/delivery.ts`); v2 `apps/runner/src/delivery/connect.ts`, `prepare.ts`
- `apps/web/src/components/runs/RunStepsCard.tsx`, `RunStepsEditor.tsx`, `apps/web/src/components/setup/ProposalReview.tsx`,
  `apps/web/src/components/delivery/setup/{DeploySetupOverview,WhereStep,SignInStep,FoundChanges,WhenStep,SecretsStep,SetupReview}.tsx`,
  `apps/web/src/api/queries/setup.ts`
Modify:
- `packages/shared/src/runs/plan.ts` (optional `label`, `template`), `events/run.ts` (`RunPlanSaved` fields),
  `events/devops.ts` (`requestKind` values), `events/delivery.ts` / deploy target events (optional fields),
  `protocol/runner.ts` (`deploy.probe`, `recipe.write`, capabilities), `delivery/protocol.ts`, `delivery/recipe.ts`
  (lint code `hand_edited`)
- `apps/server/src/commands/runs.ts` (owner plans, `findReplay`, stale rules), `projections/runs.ts`,
  `commands/deploy-targets.ts` (`checkShape`), `delivery/recipes.ts` (`observeRecipe` setup + hand-edit), `delivery/rpc.ts`,
  `delivery/runs.ts` (nothing in v1 beyond tests), DevOps brief and `buildDevopsSettings` for scan kinds,
  `routes/runs.ts`, `routes/delivery.ts`
- `apps/runner/src/runner.ts` (capabilities, command dispatch), `apps/runner/src/aom/aom-cli.ts`
  (`aom setup propose`, `aom deploy probe`), `shifts/supervisor.ts` (IPC methods), `apps/runner/src/version.ts`
  (`RUNNER_VERSION` bump); v2 `delivery/exec.ts` (`AOM_DEPLOY_SSH`)
- `apps/web/src/components/runs/RunSettings.tsx` (becomes the technical-details part), `DeployTargetsPanel.tsx`
  (production checkbox, workstation for local, status line), `delivery/DeliveryPanel.tsx` (hosts the overview),
  `pages/ProjectSettings.tsx`; `docs/USER-GUIDE.md` (Run and test, Integration tests, Phases and deploys),
  `docs/ARCHITECTURE.md` (runner commands, events)

---

## 12. Open questions for the owner

1. **UAT build source (Q5):** the adopted UAT will build from the approved commit of each merge instead of the main
   checkout. OK to switch, and is the image tag `aom-uat-app:<sha>` fine (old tags pile up; prune policy)?
2. **Production DB backup:** keep the newest how many (default 20)? Does a failed backup block the release (default
   yes)?
3. **Automatic rollback** of the app image when production health fails: on by default (proposed yes; the database is
   never rolled back automatically)?
4. **DevOps vs the owner's run plan (Q3):** after a failed start, may DevOps save a fixed per-workstation plan that is
   used right away (proposed, keeps card tests flowing), or only propose and wait for you?
5. **Project-wide run plan:** one plan for all workstations with per-workstation overrides (proposed), or keep strictly
   per workstation?
6. **Production gate defaults:** UAT healthy on the same commit for how long (`forMinutes`, proposed 10) before Release
   is offered? Also require the regression suite (`checksPassed: regression`) by default?
7. **Who may run the wizard:** project owners only (proposed) or also org Admins? Approval stays yours.
8. **Image build location:** build on the workstation and ship over ssh (proposed, matches today) vs build on the
   server (needs the code there).
9. **HTTPS/proxy in v2:** support Caddy only (proposed; matches `deploy/Caddyfile`), or nginx too?
10. **Dedicated deploy key location:** runner data dir `~/.aom-runner/keys/deploy/` (proposed; not visible in `~/.ssh`)
    vs `~/.ssh/aom_deploy_<target>` like the git keys.
11. **First guided deploy:** require one dry run per new setup version before Save is allowed (proposed), or only
    recommend it?
12. **Moves (v3):** is a short downtime acceptable (stop the old app, final backup, restore, switch DNS), or do you need
    a no-downtime move?
13. **CEO conversation path (front-door section 10):** keep it as an alternative entry that produces a `setup.json`
    proposal (proposed), or retire hand-written recipes for guided ones?

## 13. Owner decisions (2026-10-20)

All 13 open questions in §12 are accepted as proposed. Build all phases (v1a, v1b, v2, v3) after the chat release ships.

## 14. Build notes

### v1a (built 2026-10-20, branch `deploy-run-setup`)

Built as designed: section 3.1 (Run and test: `RunStepsCard`, `RunStepsEditor`, `RunStepForm`, `RunTestPanel`, advanced view inside
"Show technical details"), the production checkbox, "Deploys from" and Edit on deploy targets, the project-wide run plan with
`RunPlanSaved.source` and the `findReplay` fallback, owner save, and the generic scan (`run_scan`, read-only brief and guard,
`aom setup propose`, `SetupProposalSubmitted/Resolved`, `ProposalReview`). Migration `2280_run_steps_and_scans.sql`. Runner
capability `setup-scan:1` (announced by this runner code; `RUNNER_VERSION` is bumped at release, not here).

Deviations and additions, each small:

1. **No "Cancel scan".** DevOps requests have no cancel today, so a scan runs to its end (the shift limit is 30 minutes). A
   queued or running scan older than 45 minutes no longer counts as open (`SCAN_OPEN_MS`), so the user can start another one.
2. **No push notification or desk notice** when a proposal arrives ("push when ready" in J1). Push categories are a closed set;
   the page follows the request over the socket (`run-plan` query key) and polls every 10 s while a scan is open. Follow-up.
3. **"Test these steps" replays an unsaved plan.** `POST /api/projects/:id/run-plan/test {workstationId, plan?}` starts an
   ordinary manual environment with `replay` set from the posted plan (`buildHash: null`, a fresh `planId`, no `plan_id` on the
   environment row). A failed replay of such an environment ends it as `failed` with the reason and files **no** DevOps repair
   (a draft is not a plan anyone relies on). The design said "saves as a draft plan"; there is no draft table, the plan lives in
   the editor until "Use these steps".
3b. **`DELETE /api/projects/:id/run-plan/:planId`** (new, `RunPlanDiscarded`) implements "Use the project version here"; it only
   accepts a workstation's own plan.
4. **Questions are answered by editing the part they are about.** A question's `path` selects the part (`/services/N/...`,
   `/setup/N/...`); "Answer" opens that part's form with the question above it, and saving the form marks the part checked.
   Parts whose weakest item is `unknown` block "Use these steps" until checked; `guessed` parts show "Looks right" but never
   block. No inline typed answer applied by JSON pointer (the leaf types are too varied: a port is a number, readiness an object).
5. **`deploy` scans are refused** (`400 scan_not_available`) until v1b; everything else is generic (see "For v1b" below).
6. **`compose_stack`** uses `-p aom-run-<name>` (own throwaway project, never an adopted stack, `down` without `-v`), not
   `${envShort}` as the design table says: the runner has no `${env}` template, and a new one would not work on older runners.
   Two environments of the same project that both start the same compose part on one workstation would share the project name.
   **`docker_service`** has no `--name` for the same reason (`docker run --rm -p ${port}:<p> -e ... <image>`), and the postgres
   and mysql presets carry a fixed throwaway test password in `-e` (shown in plain words as "a simple test password").
7. **Read-only scan enforcement** is the guard (`GuardConfig.readOnlyScan`, `scanVerdict`) plus the user's clones passed as
   `--add-dir` so the DevOps settings deny `Edit` on them; there is no separate settings profile (`buildDevopsSettings` is
   unchanged). `aom deploy probe` does not exist yet (v1b), so the run scan brief does not mention it.
8. **Migration also relaxes `deploy_targets`**: the CHECK `(kind = 'remote_ssh') = (workstation_id IS NOT NULL)` became
   `kind <> 'remote_ssh' OR workstation_id IS NOT NULL` so a local Docker target can name its workstation. `deployWorkstations`
   (phase follow-ups) uses that workstation when a target has one. Unticking production needs no extra role yet (design 8).
9. **Target card**: "Deploys from" shows the workstation's online dot only (no ssh reachability: v1b/v2). The create form's
   kind labels are "On a computer (Docker)" and "On my own server (over SSH)"; the old "Kind" label changed (test updated).
10. `describeService` has plain sentences for the Docker templates ("Starts a throwaway postgres:16 in Docker for testing") so a
    person never has to read the `docker run` line; the command is in the technical details of the card.

Version skew: all new fields are optional or nullable; an old runner never receives `setup.propose`/scan work (the server checks
`setup-scan:1` and answers `409 scan_not_supported`, the page says "too old"); `replay` with `buildHash: null` already exists, but
only runners with `runs:2` replay at all (others go through DevOps as before); `RunPlanSavedMsg` from the runner is unchanged.

For v1b (`deploy_scan`): `startScan` and `scanBriefFor` take the area from `SCAN_REQUEST_KIND`; add a `deploy` branch to the brief
(`renderScanSection` has the run hints only), the `deploy` check in `setupProposeRpc` (typed `DeliverySetup`, repo/probe rules),
and lift the area guard in `startScan`. `ProposalReview` is the shared frame (questions, notes, secrets, Use/Dismiss, a test
slot); the run body is `RunStepsEditor` in `review` mode. `SetupProposalSchema.deploy` is an opaque record; pointers into it are
already validated. The e2e project `run-steps` depends only on `auth` (the core-loop chain is broken on main for another
reason); the mock DevOps agent submits a fixed run proposal for a scan request and none when the request text has
`[no_proposal]` (see `mock-agent.ts`).
