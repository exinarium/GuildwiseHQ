# GWP-161 Release docs prep: per-repository user guide path setting

## 1. Question

The 'Update user guide' step of Release prep (docs and videos) always works on `docs/USER-GUIDE.md`. Should each
repository of a project be able to name its own Markdown guide? If so, how is the path stored, checked, shown, sent to
the runner and used by the guide step and the PDF rebuild? Before planning, check whether such a setting already
exists on release/1.6.0.

## 2. Pre-check on release/1.6.0 (requirement 0, AC 6)

I read the code at `f6b71d8d` (release/1.6.0). **No configurable guide path exists.** The card stays open.

| Place | What it does today |
|---|---|
| `packages/shared/src/release/docs-prep.ts:104` `ReleaseDocsPrepSettings` | `{ enabled, steps }` only |
| `packages/shared/src/release/docs-prep-dto.ts:56` `ReleaseDocsPrepSettingsSchema` (PUT body) / `:61` DTO | no path, no repository list |
| `packages/shared/src/events/release-docs-prep.ts:11` `ReleaseDocsPrepSettingsSet` | `{ projectId, enabled, steps, setBy }` |
| `apps/server/src/projections/release-docs-prep.ts:24` | writes `projects.release_docs_prep = {enabled, steps}` (jsonb, whole value) |
| `apps/server/src/release/docs-prep.ts:71` `settingsOf`, `:78` get, `:100` set | reads/writes enabled and steps only; manager rule `requireManager`/`canManage` |
| `apps/server/src/release/docs-prep-steps.ts:47` guide hook | always sends `guidePath: DEFAULT_GUIDE_PATH` |
| `packages/shared/src/release/user-guide.ts:12,660` | `DEFAULT_GUIDE_PATH = 'docs/USER-GUIDE.md'`; `ReleaseDocsPrepGuideInputSchema.guidePath` defaults to it |
| `apps/runner/src/git/release-docs-prep-guide.ts:144` | already reads `guidePath` from the input; the check (`isAbsolute` or `startsWith('..')` after `normalize`) misses `..foo`-style names being wrongly refused, Windows drive and UNC forms, and symlinks that point outside the worktree |
| same file `:148` | a missing file returns ok with `skipped: 'no user guide'` |
| same file `:299` | the PDF scripts are looked up at `<dirname(guidePath)>/guide/`; `docs/guide/assemble-guide.mjs:16` reads `../USER-GUIDE.md` (hard-coded) |
| `apps/web/src/components/ReleaseDocsPrepPanel.tsx` | switch and step checklist; saves on every change; no repository list |

Nothing else in prep reads the guide: `DEFAULT_GUIDE_PATH` is used only in the server hook and the runner step.

## 3. Findings that shape the design

1. **Storage needs no migration.** Settings are a jsonb value on `projects`, written whole by the projector. A new key
   `guidePaths` fits there. Old events replay to "no key", which means the default.
2. **Events must carry the whole map.** The projector replaces the whole jsonb value. If the event carried only a
   change, a later switch toggle would wipe the paths. So every `ReleaseDocsPrepSettingsSet` carries the full resulting
   `guidePaths` map.
3. **"Missing file" has two meanings.** Today a repository without `docs/USER-GUIDE.md` is skipped. AC 1 says
   unconfigured projects behave exactly as before. AC 5 says a *configured* file that is missing fails. The runner
   therefore needs to know whether the path was configured. It cannot work this out from the path alone: today's
   servers always send `guidePath: 'docs/USER-GUIDE.md'`.
4. **The PDF build only knows `USER-GUIDE.md`.** `assemble-guide.mjs` reads `../USER-GUIDE.md` and writes the table of
   contents back into it. If prep ran it for `docs/guide/MANUAL.md`, it would build and edit `docs/USER-GUIDE.md`. That
   breaks AC 4 ("not docs/USER-GUIDE.md"). Today the runner already refuses that result (`the guide build changed
   docs/USER-GUIDE.md`), so the step would fail after a correct text edit.
5. **The runner may run an older or newer version than the server** (runners live on user workstations). A new server
   with an old runner would still send the path, and the old runner reads it. But for a missing file the old runner
   skips instead of failing (AC 5). Capabilities (`release-docs-prep-changelog:1` pattern,
   `apps/server/src/release/docs-prep-changelog.ts:102`) are the existing way to handle this.
6. **The repository name is available at dispatch.** The dispatch row in `dispatchAction` (`docs-prep.ts:492`) selects
   `pr.name`, so the hook can pass it to the runner for the error message.

## 4. Options

### 4.1 Where to store the path

| Option | For | Against |
|---|---|---|
| **A. `projects.release_docs_prep.guidePaths` keyed by repository id** (recommended) | Card wording ("release docs prep settings get ... per repository"); one event, one permission rule, one audit trail, one panel; no migration | Map entries for removed repositories must be ignored |
| B. New column on `project_repos` (like the GWP-49 'Release name' repository setting) | Lives with the repository | Needs a migration, a separate event, permission and audit path, and a second UI location. The card asks for the same rules as the prep settings |

### 4.2 How the runner tells "configured" from "default"

| Option | Against |
|---|---|
| Omit `guidePath` when unset, and treat its presence as "configured" | Old servers always send the default, so a new runner would start failing repositories without a guide. That breaks AC 1 |
| **Explicit `guidePathConfigured: boolean` (default false)** (recommended) | none: old servers do not send the flag, so it is false and the step skips as before |

### 4.3 PDF rebuild with a custom path (planner's open question)

| Option | Against |
|---|---|
| Pass the path to `assemble-guide.mjs` (new `--md` flag) | Prep runs on any project's repository. A repository's own scripts do not know the flag. Today's `assemble-guide.mjs` ignores unknown flags and would silently build `USER-GUIDE.md` |
| **Rebuild only when the guide's file name is `USER-GUIDE.md` (the name the scripts read) and `<dir>/guide/assemble-guide.mjs` exists; otherwise `pdf: 'no PDF build'` with a note** (recommended) | A custom-named guide gets no PDF from prep. That is acceptable and stated in the output; teaching the scripts a `--md` flag is a backlog follow-up |

## 5. Recommendation and design

Build it as A + explicit flag + PDF gating. Unset means exactly today's behaviour in every layer.

### 5.1 Shared (`packages/shared`)

`packages/shared/src/release/user-guide.ts`: add a pure validator next to `DEFAULT_GUIDE_PATH`, and use it in the
server and the runner:

```ts
export const GUIDE_PATH_MAX = 300;

export type GuidePathCheck = { ok: true; path: string | null } | { ok: false; reason: string };

/** A repository-relative Markdown path; null = not set (the default docs/USER-GUIDE.md). */
export function normalizeGuidePath(raw: string | null | undefined): GuidePathCheck {
  const t = (raw ?? '').trim();
  if (!t) return { ok: true, path: null };
  if (t.length > GUIDE_PATH_MAX) return { ok: false, reason: `is longer than ${GUIDE_PATH_MAX} characters` };
  if (/[\u0000-\u001f]/.test(t)) return { ok: false, reason: 'contains control characters' };
  const s = t.replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(s)) return { ok: false, reason: 'must be relative to the repository (no drive letter)' };
  if (s.startsWith('/')) return { ok: false, reason: "must be relative to the repository (no leading '/')" };
  const parts = s.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) return { ok: false, reason: "must not contain '..'" };
  const path = parts.join('/');
  if (!/\.md$/i.test(path) || /^\.md$/i.test(parts.at(-1) ?? ''))
    return { ok: false, reason: 'must be a Markdown file ending in .md' };
  return { ok: true, path: path === DEFAULT_GUIDE_PATH ? null : path };
}
```

Notes: `'./docs//x.md'` becomes `docs/x.md`. `docs\..\x.md` becomes `docs/../x.md` and is rejected. A UNC path
`\\host\x.md` becomes `//host/x.md` and is rejected by the leading-`/` rule. Entering the default is the same as leaving
the field empty (stored as unset). This keeps "configured" meaning "a different file". Note `'..foo/x.md'` is allowed
(it is a normal name, not a `..` segment).

`ReleaseDocsPrepGuideInputSchema` (same file, line 660) gains two optional fields. `guidePath` and its default stay:

```ts
  /** True when the repository has its own guide path: a missing file then fails instead of skipping. */
  guidePathConfigured: z.boolean().default(false),
  /** For messages only. */
  repoName: z.string().max(200).optional(),
```

`packages/shared/src/release/docs-prep.ts`: `ReleaseDocsPrepSettings` gains `guidePaths?: Record<string, string>`
(repository id to normalised path). `DEFAULT_RELEASE_DOCS_PREP` stays unchanged.

`packages/shared/src/release/docs-prep-dto.ts`:

```ts
export const ReleaseDocsPrepSettingsSchema = z.object({
  enabled: z.boolean(),
  steps: z.record(z.string().max(40), z.boolean()),
  /** Per repository id: the user guide path; '' clears it. Absent: unchanged. Only the keys sent change. */
  guidePaths: z.record(z.uuid(), z.string().max(400)).optional(),
});
// DTO: add
  repos: z.array(z.object({ id: z.string(), name: z.string(), guidePath: z.string().nullable() })).default([]),
  defaultGuidePath: z.string(),
```

The body schema does no path checks (max 400 only), so that the server can return its own readable 400 (see 5.2)
instead of a generic schema error.

`packages/shared/src/events/release-docs-prep.ts`: `ReleaseDocsPrepSettingsSet` gains
`guidePaths: z.record(z.string(), z.string()).optional()`. It is the **full** map after the change. It is optional so
old events still parse.

Capability: `RELEASE_DOCS_PREP_GUIDE_PATH_CAPABILITY = 'release-docs-prep-guide-path:1'` in `docs-prep-dto.ts`, exported
like the changelog one.

### 5.2 Server (`apps/server`)

`src/release/docs-prep.ts`:
- `settingsOf(p)` also returns `guidePaths: Record<string,string>`. Keep only string values that still pass
  `normalizeGuidePath` with a non-null result; skip anything else (defensive read).
- `getReleaseDocsPrepSettings`: list the project's live repositories
  (`SELECT id, name FROM project_repos WHERE project_id=$1 AND removed_at IS NULL ORDER BY name, id`) as
  `repos: [{ id, name, guidePath: s.guidePaths[id] ?? null }]`, plus `defaultGuidePath: DEFAULT_GUIDE_PATH`. List
  every live repository, not only those with a release branch, so a repository can be set up before its first release
  branch.
- `setReleaseDocsPrepSettings(input with guidePaths?)`, inside the existing transaction after `requireManager`. A
  non-manager still gets 403 first:
  1. For each key in `input.guidePaths`: an unknown or removed repository of this project gives
     `badRequest('unknown_repo', 'unknown repository: <id>')`. Otherwise call `normalizeGuidePath`. On failure:
     `badRequest('invalid_guide_path', \`The user guide path for ${repo.name} ${reason}: ${raw.trim()}\`)`, for example
     "The user guide path for GuildwiseHQ must not contain '..': ../x.md". Check every key before writing anything, so
     a request either applies completely or not at all.
  2. `next = { ...before.guidePaths }`. Apply each key (null deletes it). Drop keys for repositories that are no longer
     live.
  3. Add the paths to the `same` check (compare the maps by key and value). An unchanged save still writes no event.
  4. Append `ReleaseDocsPrepSettingsSet` with `guidePaths: next`. This is the same stream, actor and scope as today, so
     the audit trail is the same as for the other settings (requirement 3).
- When `input.guidePaths` is absent (today's web calls and any other client), the paths stay as they are.

`src/projections/release-docs-prep.ts:24`: write
`{ enabled, steps, ...(p.guidePaths && Object.keys(p.guidePaths).length ? { guidePaths: p.guidePaths } : {}) }`.

`src/release/docs-prep-steps.ts` guide hook:

```ts
stepInput: async (db, run, repo) => {
  const p = await one(db, 'SELECT release_docs_prep FROM projects WHERE id=$1', [run.project_id]);
  const configured = guidePathOf(p?.release_docs_prep, repo.repo_id); // normalised or null (shared helper or local)
  return {
    guidePath: configured ?? DEFAULT_GUIDE_PATH,
    guidePathConfigured: configured !== null,
    repoName: repo.name ?? '',
    coveredSources: await guideCoveredSources(db, run, repo.repo_id),
    denyList: [],
  };
},
```

The path is read when the step is dispatched, not frozen at run start. A Retry after fixing the setting then uses the
new value. Note this in the user guide.

Capability gate in `dispatchAction` (`docs-prep.ts`, around line 513, before the writer lookup), only for
`action.step === 'guide'` and only when the repository has a configured path. If the workstation lacks
`RELEASE_DOCS_PREP_GUIDE_PATH_CAPABILITY`, call `failStepBeforeDispatch(..., \`The workstation that has ${repo.name}
needs a newer runner to use the user guide path ${path}. Update the runner and retry.\`)`. Copy the capability query
from `changelogDispatchFor`. Unconfigured repositories are never checked, so AC 1 holds on old runners too.

`src/routes/release-docs-prep.ts`: no change beyond the schema (the body schema comes from shared). The PUT already
returns the fresh DTO.

### 5.3 Runner (`apps/runner`)

`src/git/release-docs-prep-guide.ts`, `runGuideStep`:

```ts
const checked = normalizeGuidePath(input.data.guidePath);
if (!checked.ok) return fail(`refusing the user guide path ${input.data.guidePath}: it ${checked.reason}`);
const guidePath = checked.path ?? DEFAULT_GUIDE_PATH;
const where = `${guidePath} on ${ctx.payload.releaseBranch}${input.data.repoName ? ` in ${input.data.repoName}` : ''}`;
const abs = join(wt, guidePath);
if (!existsSync(abs) || !statSync(abs).isFile()) {
  if (input.data.guidePathConfigured)
    return fail(`the user guide ${where} does not exist. Fix the path in Project settings > Release prep (docs and videos), or add the file.`);
  return { ok: true, files: [], output: { ...empty('passed'), skipped: 'no user guide' } }; // unchanged
}
// never leave the worktree, even through a symlink
const real = realpathSync(abs), root = realpathSync(wt);
if (real !== root && !real.startsWith(root + sep)) return fail(`refusing the user guide ${where}: it points outside the repository`);
```

The default path then goes through the same validator. `normalizeGuidePath('docs/USER-GUIDE.md')` returns `null`,
which maps back to the default.

PDF gating (around line 298), replacing `if (!existsSync(join(wt, assemble)))`:

```ts
const pdfReadsThisFile = basename(guidePath) === 'USER-GUIDE.md'; // the scripts read ../USER-GUIDE.md
if (!pdfReadsThisFile || !existsSync(join(wt, assemble))) {
  out.pdf = 'no PDF build';
  if (!pdfReadsThisFile && existsSync(join(wt, assemble)))
    out.notes.push(`the PDF guide was not rebuilt: its scripts build USER-GUIDE.md, not ${guidePath}`);
} else { /* unchanged build loop (GWP-160 adds --date/--edition here) */ }
```

For the default path the condition is exactly today's. The final `inside` check stays and keeps refusing changes
outside `guidePath` and the scripts folder.

`src/runner.ts:1494`: announce `RELEASE_DOCS_PREP_GUIDE_PATH_CAPABILITY` next to
`RELEASE_DOCS_PREP_CHANGELOG_CAPABILITY`.

`src/git/release-docs-prep-steps.ts`: no change (the handler registry stays the same).

### 5.4 Web (`apps/web`)

`src/api/queries/releaseDocsPrep.ts`: widen the mutation variable type to
`{ enabled; steps; guidePaths?: Record<string, string> }`.

`src/components/ReleaseDocsPrepPanel.tsx`: below the Steps fieldset, add a "User guide" fieldset with one row per
`data.repos` (hide the fieldset when the list is empty):
- `<label>` with the repository name. `<input type="text">` with `placeholder={data.defaultGuidePath}`,
  `data-testid={\`prep-guide-path-${repo.id}\`}`, `disabled={!canEdit || save.isPending}`.
- Touch and soft keyboard: `autoCapitalize="off"`, `autoCorrect="off"`, `spellCheck={false}`, `inputMode="text"`,
  `enterKeyHint="done"`, full width on narrow screens, at least 44px high (`min-h-11`, like the rows above).
- Local draft state per repository, set from `data` in the existing `useEffect`. **Save on blur and on Enter** (not per
  keystroke), and only when the trimmed draft differs from the saved value. Call
  `save.mutate({ enabled, steps, guidePaths: { [repo.id]: draft } })`. This is the same mutation the switch and the
  checklist use (requirement 4). An empty value clears it.
- Help line under the field: "Relative to the repository, ending in .md. Empty: docs/USER-GUIDE.md. The PDF guide is
  rebuilt only for a file named USER-GUIDE.md."
- A 400 is shown **inline under that field** (`role="alert"`, `aria-invalid` and `aria-describedby` on the input),
  not as a toast. Keep the draft so the user can fix it. Show the error under the field whose save failed. The existing
  `<ErrorBox error={save.error} />` stays for the switch and checklist errors; do not show the same error twice.
- After reload the saved value comes back from GET (AC 2).

### 5.5 Docs

- `docs/USER-GUIDE.md` (line ~1407, Release prep paragraph): describe the per-repository **User guide path** field.
  Cover the default, the rules, that a configured file that is missing fails the step with the repository and path,
  that the PDF is rebuilt only for `USER-GUIDE.md`, and that Retry uses the current value.
- `docs/RUNNER.md` (line ~1546 content steps, ~1552 capabilities): `guidePath`, `guidePathConfigured`, `repoName`
  in the guide `stepInput`; the missing-file rule; the symlink rule; the new capability `release-docs-prep-guide-path:1`.

### 5.6 Data model and migration

No migration. `projects.release_docs_prep` jsonb gains an optional `guidePaths: { "<repoId>": "<path>" }`. Existing rows
and replayed old events have no key, which means the default for every repository.

## 6. Risks

| Risk | Mitigation |
|---|---|
| A later settings save wipes the paths | Events carry the full map; `guidePaths` absent in the body means unchanged; test it |
| Path escapes the worktree (`..`, absolute, drive, UNC, symlink) | Shared validator on save **and** in the runner; realpath check in the runner |
| Old runner skips a missing configured file | Capability gate fails the step before dispatch with "update the runner" |
| PDF scripts edit `USER-GUIDE.md` for a custom guide | PDF gating on the file name; the existing outside-changes check stays |
| A setting for a removed repository | Ignored on read; dropped on the next save |
| GWP-160 edits the same PDF block | GWP-161 builds after GWP-160 and only wraps the block in a condition (section 8) |

## 7. Acceptance criteria to design

| AC | Design |
|---|---|
| Existing projects run as before on docs/USER-GUIDE.md | No key gives `guidePathConfigured: false` and the default path. Missing file is still skipped, the PDF condition is unchanged for the default, no capability check (5.2, 5.3). Test: the existing runner and server suites unchanged, plus a hook test showing an unset repository sends the default with `configured: false` |
| Manager sets the path in the panel; it shows again after reload | Panel field and save on blur/Enter; GET returns `repos[].guidePath` (5.4, 5.2). Web test: render, type, blur, PUT body has `guidePaths`, re-render from GET shows the value |
| API rejects absolute, '..', non-.md with a readable 400; non-manager cannot change | `normalizeGuidePath` plus `invalid_guide_path` 400 naming the repository; `requireManager` runs first, so 403 (5.1, 5.2). Shared unit tests plus server API tests |
| With docs/guide/MANUAL.md the step reads and edits that file, not docs/USER-GUIDE.md | Hook sends the configured path; runner edits `abs`; PDF gating stops the scripts from touching USER-GUIDE.md (5.2, 5.3). Runner test with both files present: only MANUAL.md changes, and `pdf: 'no PDF build'` with a note |
| Missing configured file fails, naming repository and path | `guidePathConfigured` plus `repoName` give the fail message (5.3). Runner test checks the error text contains the path and the repository name |
| Pre-check recorded; closed if it already exists | Section 2; posted on the card. It does not exist, so the card goes to build |

## 8. Assumptions about unlanded dependencies (GWP-160)

1. GWP-160 changes `docs/guide/build-guide.mjs`, `docs/guide/parts/cover.html` and the PDF build loop in
   `runGuideStep` (adds `--date`/`--edition` or an env var to the `build-guide.mjs` call, and maybe a step-output note).
   It does **not** change where the runner looks for the scripts (`<dirname(guidePath)>/guide/`), the missing-file
   branch, or `ReleaseDocsPrepGuideInputSchema.guidePath`. If it does, merge the GWP-161 gating and missing-file
   changes into its version; the rules in 5.3 stay the same.
2. GWP-160 does not make `assemble-guide.mjs` read a configurable Markdown path. If it does (for example a `--md`
   flag), the PDF gating in 5.3 can be relaxed: pass the configured path to that flag instead of skipping the PDF for
   non-`USER-GUIDE.md` names.
3. The release date and version that GWP-160 passes come from the server through the payload or `stepInput`. If it
   adds fields to `ReleaseDocsPrepGuideInputSchema`, they live alongside `guidePathConfigured` and `repoName`. Only the
   object literal in the server hook needs merging.

## 9. Test plan for the builder

1. `packages/shared/test/user-guide.test.ts`, `normalizeGuidePath`: accepts `docs/USER-GUIDE.md` (to null),
   `docs/guide/MANUAL.md`, `./docs//guide/MANUAL.md` (to `docs/guide/MANUAL.md`), `docs\guide\MANUAL.md` (to forward
   slashes), `'  '` (to null). Rejects `/etc/x.md`, `C:\x.md`, `c:x.md`, `\\host\x.md`, `../x.md`, `docs/../x.md`,
   `docs\..\x.md`, `docs/x.txt`, `docs/.md`, and over 300 characters. The input schema defaults
   `guidePathConfigured` to false.
2. `apps/server/test/release-docs-prep.test.ts` (settings describe, line ~153): GET lists repos with `guidePath: null`
   and `defaultGuidePath`. Owner PUT with `guidePaths` persists and GET returns it normalised. A member's PUT gives 403.
   `../x.md`, `/x.md` and `x.txt` give 400 `invalid_guide_path` with the repository name in the message. An unknown
   repository id gives 400. A PUT without `guidePaths` keeps the stored paths. An unchanged save writes no new event.
   Hook/dispatch: a configured repository sends `guidePath`, `guidePathConfigured: true` and `repoName`. A workstation
   without the capability fails the guide step before dispatch. These tests use the server test harness with Postgres:
   run them where the harness runs, or leave them to the testers and say so in the handoff.
3. `apps/runner/test/release-docs-prep-guide.test.ts` (fixture at line ~47): custom path with both files present: only
   the custom file changes. Unset path: `docs/USER-GUIDE.md` as today. Configured and missing: `ok: false`, and the
   error contains the path and the repository name. Unconfigured and missing: skipped `no user guide` (unchanged). A
   symlink to outside the worktree is refused. A custom name with `docs/guide/assemble-guide.mjs` present gives
   `pdf: 'no PDF build'` plus a note, and no exec of the scripts.
4. `apps/web/src/test/release-docs-prep.test.tsx`: the field renders per repository with the placeholder. Blur sends
   PUT with `guidePaths`. A 400 shows inline under the field. Read-only users see the field disabled.
5. Regression: all existing release-docs-prep suites (shared, server, runner, web) pass unchanged.

## 10. Follow-up (outside this card)

Teach `docs/guide/assemble-guide.mjs` and `build-guide.mjs` a `--md <path>` flag, so that a custom-named guide can get
a PDF too. This is a backlog suggestion, not part of GWP-161.
