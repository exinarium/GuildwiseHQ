# GWP-258: The deploy screen shows the commit before confirm and takes an explicit commit

Repository: GuildwiseHQ, `apps/web` only. First design read: `origin/development` at 77a23d96. Assumption review read: the
working branch at 86ac3959, after GWP-257 landed (fb7465d4).

GWP-257 has landed. Section 7 records how each assumption was checked against the landed code. One did not hold:
assumption 2, the field names of the preview DTO. Sections 4.2, 4.4, 4.5, 4.6 and 6 are updated to the real DTO. The
landed code also adds an `expectCommit` guard on the deploy request, which this design now uses (section 4.5). Everything
else is unchanged.

## 1. Question

The deploy screen (`ReleaseSheet`, opened from the environment card's Release button) does not say which commit a deploy will
build. It also has no way to enter a commit, although `POST /api/projects/:id/delivery/deploy` already accepts one from an
Owner or Admin. The card asks for:

- a server-provided preview of the commit (short SHA, full SHA on hover or copy, subject, date and source in words),
- an optional Commit field that refreshes the preview (debounced) or shows the server's error inline,
- confirm sends the entered commit, and sends nothing when the field is empty,
- confirm stays disabled while the preview loads or has failed,
- no change to RollbackSheet.

## 2. Findings (current code)

### 2.1 ReleaseSheet has two confirm paths

`apps/web/src/components/environments/ReleaseSheet.tsx`:

```ts
const w = status.data?.find((s) => s.env === env)?.waitingRelease ?? null;
...
const go = () => {
  setRefused(null);
  if (w && places.length > 0)
    release.mutate(chosen.map((p) => p.runId), { onSuccess: answered });          // (A) release path
  else deploy.mutate({ env, ...(w?.commit ? { commit: w.commit } : {}) }, { onSuccess: answered }); // (B) deploy path
};
```

- **(A) Release path.** A run already waits for release (`waitingRelease` plus queue `targets` → `places`). Confirm posts
  `runIds` to `/api/delivery/release`. The run's commit was fixed when it was requested, and this endpoint cannot take a
  commit.
- **(B) Deploy path.** Nothing waits, or a waiting release came without places (the queue fetch failed, see
  `useEnvStatus`'s `.catch(() => ({ items: [] }))`). Confirm posts `{ env, commit? }` to `/delivery/deploy`. It sends
  `w.commit` when a waiting release exists, and otherwise no commit, so the server default applies (since GWP-257:
  `resolveDeployCommit`).
- The "Version" block shows `w?.version ?? short(w.commit) ?? 'the latest approved version'`. With nothing waiting, the owner
  does not see what will be built. This is bug 2.
- Confirm is `disabled={!!reason || status.isPending}`. `reason` covers rules not met and no place ticked.

### 2.2 API layer

- `useDeploy(projectId)` in `apps/web/src/api/queries/delivery.ts` already takes a `DeployRequest`, and `commit` is optional
  there. **`useDeploy` needs no change.** Since GWP-257 `DeployRequest` also has `expectCommit?` (section 4.5).
- `DeployRequestSchema` is in `packages/shared/src/api/delivery.ts`. Since GWP-257 `commit` and `expectCommit` use a shared
  `Sha` schema: `z.string().trim().toLowerCase().regex(/^[0-9a-f]{7,64}$/)`. A bad format is rejected by the route schema with
  a 400 `validation_error` and the message "request validation failed" (`apps/server/src/app.ts:390`), which is not useful
  on screen.
- `useRelease()` posts `{ runIds }` only. It keeps doing that.
- `EnvRelease.commit` is `''` when the server sent `null` (`adaptStatus`, `statusFromRuns`). Treat `''` as "no commit".

### 2.3 Reusable pieces already in the web app

| Need | Existing piece |
|---|---|
| Dialog, error, spinner, button | `Dialog`, `ErrorBox`, `Spinner`, `Button`, `TextInput` in `components/ui.tsx` |
| Labelled input with an id | `TextInput` (uses `Field`, `useId`, `aria-invalid`) |
| Copy full SHA (works on touch) | `components/delivery/connect/CopyButton.tsx` (`text`, `label`, `testId`) |
| Debounce | private `useDebounced` in `components/builder/RoleBuilder.tsx:56` |
| Date | `formatDateTime` in `lib/time.ts`, `agoText` in `lib/ago.ts` |
| Error type | `ApiError { status, code, message }` in `api/client.ts` |
| Dev mock API (MSW) | `apps/web/src/mocks/handlers-releases.ts` (used by `pnpm dev:mock`, `e2e/tests/environments.spec.ts` and the video) |

### 2.4 Who else uses what changes

- `ReleaseSheet` is rendered only by `EnvironmentCard.tsx`. Its props do not change, so EnvironmentCard needs no change.
- Unit tests that render it: `apps/web/src/test/releases.test.tsx` (the ReleaseSheet tests, all on the release path; the
  file also gained badge tests in 78ccd977, which do not open the sheet). `deploy-setup.test.tsx` and
  `removed-computer.test.tsx` only check the Release button and never open the sheet.
- E2E: `e2e/tests/environments.spec.ts` opens the sheet against the MSW mock and checks the title only. The deploy specs
  call the API directly. No E2E spec needs to change, but the mock needs a preview handler so the sheet does not show an error
  in mock mode (section 4.6).
- RollbackSheet does not share code with ReleaseSheet. It is untouched.

### 2.5 What GWP-257 landed (checked for this review)

- Route `GET /api/projects/:id/delivery/deploy/preview` in `apps/server/src/routes/delivery.ts`, querystring
  `DeployCommitPreviewQuerySchema = { env, commit?: Sha, target? }`, Owner/Admin only (403 otherwise), synchronous answer.
- `previewDeployCommit` (`apps/server/src/delivery/runs.ts`) calls the same `resolveDeployCommit` as `requestDeployRun`.
  It resolves for the first active target of the environment. The commit is read through the deploying workstation (a probe
  with a timeout), so the answer can take a few seconds.
- Resolution order: the commit a person named (`explicit`), the newest shipped release on a live environment (`release`,
  detail "release 1.9.0"), what an earlier environment runs through a gate's `envHealthy` (`promoted`, detail "what test
  runs"), the working branch tip (`working-branch`, detail "tip of main").
- Errors, all `{ error: { code, message } }`: 422 `commit_unknown` ("commit X is not in repo"), 422 `commit_ambiguous`
  ("X matches several commits in repo: give more characters"), 409 `commit_unresolved` (workstation offline, too old,
  timeout, no repository or no working branch), 409 `no_vault`, 409 `no_workstation` (or another workstation reason),
  404 `unknown_env`, 404 `unknown_target`, 400 `validation_error` (bad format, from the schema).
- A deploy by an Owner/Admin with `commit` goes through `resolveDeployCommit(explicit)` and builds `r.sha` (full SHA). An
  unknown commit is a 422 with no run created.
- New: `DeployRequest.expectCommit`. When no `commit` is named and the default now resolves to a different commit, the deploy
  is refused with 409 `commit_moved` ("the commit to deploy is now abc1234, not …: look at it again and confirm") and nothing
  is created.

## 3. Options

### 3.1 What the release path (A) shows and accepts

| Option | What it does | For | Against |
|---|---|---|---|
| **A1 (recommended)** | Show the waiting run's commit through the server preview (`?commit=<w.commit>`), labelled "Waiting for release". No Commit field on this path; a short line says the release was prepared for this commit and how to choose another. Confirm still releases `runIds`. | Keeps the release flow and refusal handling as they are. One source of commit details for both paths. The owner still sees subject and date. | To deploy a different commit, the owner has to cancel the waiting release first. |
| A2 | Show the Commit field on the release path too. Entering a commit switches confirm to `/delivery/deploy` with `{ env, commit, targets }`, and the server replaces the waiting run. | One field everywhere. | Changes release semantics: cancel and replace, the gate is evaluated on the new commit, and ticked places must be mapped to target names. The card does not ask for this, and it raises the regression risk on the release tests. |
| A3 | Release path unchanged (no preview) | Smallest change | Fails AC1 whenever a release waits, which is the common production case. |

### 3.2 Where the preview comes from

| Option | For | Against |
|---|---|---|
| **P1 (recommended, landed in GWP-257)**: `GET /api/projects/:id/delivery/deploy/preview?env=&commit=` | Takes an entered commit, so the same call serves the default and the explicit case. The server uses the same resolution code as the deploy. | none |
| P2: a field on `/environments/status` | No extra request on open | Cannot preview an entered commit. Not built. |

### 3.3 What confirm sends

| Option | For | Against |
|---|---|---|
| **S1 (recommended)**: with a commit entered, send `preview.data.sha`, the full SHA the server resolved for exactly the input shown | The deploy builds exactly the commit on screen (AC3), with no ambiguity for a short prefix. | none |
| S2: send the raw typed text | Literal reading of requirement 3 | A short prefix that becomes ambiguous later would build something else. |

With the field empty, confirm sends **no** `commit` (requirement 3), but sends `expectCommit: preview.data.sha` so the server
refuses with 409 `commit_moved` if the default moved since the preview (closes the risk the first design left open). In the
deploy-path case of a waiting release without places, confirm keeps today's behaviour of sending `commit: w.commit`.

### 3.4 Validating the entered text

The web app only **normalises** the text: trim, remove inner whitespace, lowercase. It does not check that the commit
exists. Every non-empty value goes to the server preview, so the error on screen is the server's (AC4): `commit_unknown`
and `commit_ambiguous` come with plain messages. The one exception is the server's generic 400 `validation_error`
("request validation failed"), which the hook rewords as "That is not a commit SHA: use 7 to 40 characters 0-9 and a-f."

## 4. Design

### 4.1 Files

| File | Change |
|---|---|
| `apps/web/src/api/queries/delivery.ts` | Add `deployPreviewKey` and the `useDeployPreview` hook (4.2). `useDeploy` and `useRelease` stay as they are. |
| `apps/web/src/lib/useDebounced.ts` (new) | Move the debounce hook from RoleBuilder here and add a `flush` (4.3). RoleBuilder imports it, with no behaviour change. |
| `apps/web/src/components/environments/DeployCommitPreview.tsx` (new) | Shows one preview: short SHA, copy, subject, date, source (4.4). |
| `apps/web/src/components/environments/ReleaseSheet.tsx` | Path flag, Commit field, preview block, confirm gating, commit and `expectCommit` sent on confirm (4.5). |
| `apps/web/src/mocks/handlers-releases.ts` | MSW handler for the preview endpoint (4.6). |
| `apps/web/src/test/releases.test.tsx` | Preview fixture in `route()`, new tests, existing tests adjusted (section 6). |
| `docs/design/environments-ux.md` (journey I) | One bullet: the sheet shows the commit (short SHA, subject, date, source) and has an optional Commit field. |
| `apps/web/src/whats-new/entries/2026-11-XX-deploy-shows-version.md` (new, optional) | `audience: admin`. Plain words: "Before you release, the screen shows exactly which version will be built, and you can enter a specific one." |

EnvironmentCard, RollbackSheet, `environments.ts` and the shared package: **no change**. `DeployCommitPreview` is already
exported from `@aom/shared` (same module as `DeployRequest`).

### 4.2 The preview hook (`delivery.ts`)

```ts
import type { DeployCommitPreview } from '@aom/shared';
import { ApiError, del, get, post, put } from '../client.ts';

export const deployPreviewKey = (projectId: string, env: string, commit: string | null) =>
  ['deploy-preview', projectId, env, commit] as const;

/**
 * The commit a deploy of `env` would build, resolved by the server with the same code as the deploy itself. Without `commit`,
 * it is the server's default (the shipped release, what an earlier environment runs, or the working branch tip). With one,
 * it is that commit, or the server's error.
 */
export function useDeployPreview(projectId: string, env: string, commit: string | null, enabled = true) {
  return useQuery({
    enabled,
    queryKey: deployPreviewKey(projectId, env, commit),
    retry: false,
    staleTime: 0,
    queryFn: async () => {
      const q = new URLSearchParams({ env, ...(commit ? { commit } : {}) });
      try {
        const p = await get<DeployCommitPreview>(`/projects/${projectId}/delivery/deploy/preview?${q}`);
        // Never let an owner confirm on an answer that does not name a commit.
        if (!p || typeof p.sha !== 'string' || !p.sha) throw new Error('The server did not say which commit it would build.');
        return p;
      } catch (e) {
        if (e instanceof ApiError && e.code === 'validation_error')
          throw new ApiError(e.status, e.code, 'That is not a commit SHA: use 7 to 40 characters 0-9 and a-f.');
        throw e;
      }
    },
  });
}
```

- Do **not** use `placeholderData`/`keepPreviousData`. When the commit changes, the old commit must not stay on screen while
  confirm turns on again.
- No fallback for an older server (404). The web app and the server ship together from this repository.
- No `refetchInterval`. `staleTime: 0` plus the default refetch on focus is enough while the sheet is open. The server
  probes a workstation, so an answer can take seconds; `retry: false` keeps a timeout from tripling the wait.
- `qs()` from `api/client.ts` can build the query string instead of `URLSearchParams`.

### 4.3 `lib/useDebounced.ts`

```ts
/** `value` after it stopped changing for `ms`; `flush()` takes the current value at once (Enter on a soft keyboard). */
export function useDebounced<T>(value: T, ms: number): [T, () => void] {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return [v, () => setV(value)];
}
```

RoleBuilder changes from `const debounced = useDebounced(request, 500)` to `const [debounced] = useDebounced(request, 500)`.
Its tests must still pass. If the builder prefers not to touch RoleBuilder, a local copy in ReleaseSheet is acceptable.

### 4.4 `DeployCommitPreview.tsx` (updated to the landed DTO)

The landed DTO (`packages/shared/src/api/delivery.ts`):

```ts
{ env: string; repo: string | null; branch: string | null; sha: string; shortSha: string;
  subject: string | null; author: string | null; committedAt: string | null;
  source: 'explicit' | 'release' | 'promoted' | 'working-branch'; sourceDetail: string | null }
```

Props: `preview: DeployCommitPreview`, `sourceText: string`.

```tsx
<div className="flex flex-col gap-1" data-testid="release-commit">
  <div className="flex flex-wrap items-center gap-2">
    <span className="font-mono text-base text-fg" title={p.sha} data-testid="release-version">{p.shortSha || p.sha.slice(0, 7)}</span>
    <CopyButton text={p.sha} label="Copy full SHA" testId="release-commit-copy" />
  </div>
  <p className="text-fg break-words" data-testid="release-commit-subject">
    {p.subject ?? <span className="text-muted">No commit message</span>}
  </p>
  <p className="text-xs text-muted">
    {p.committedAt && (<><time dateTime={p.committedAt} data-testid="release-commit-date">{formatDateTime(p.committedAt)}</time>{' · '}</>)}
    <span data-testid="release-commit-source">{sourceText}</span>
    {p.author && <> · {p.author}</>}
  </p>
</div>
```

`subject` and `committedAt` are nullable in the DTO. The runner sends both for any commit it reads (`git log` of the
commit); null only comes from a runner message that left them out. Show "No commit message" and leave the date out rather
than block confirm: the SHA and source are always there, and the SHA is what gets built. Note in the handoff that AC1's
subject and date depend on the runner filling them.

The test id `release-version` stays on the short SHA, so the existing assertion (`toHaveTextContent('a1b2c3d')`) keeps its
meaning. The full SHA shows on hover through `title`, and on touch through Copy. The Copy button must keep the 44 px touch
target.

Source words, as a helper in the same file. `sourceDetail` comes from the server already in words ("release 1.9.0",
"what test runs", "tip of main"):

```ts
export function commitSourceText(p: DeployCommitPreview, waiting: boolean): string {
  if (waiting) return 'Waiting for release';
  const d = p.sourceDetail ? ` (${p.sourceDetail})` : '';
  switch (p.source) {
    case 'release': return `Latest release${d}`;                 // "Latest release (release 1.9.0)"
    case 'working-branch': return p.branch ? `Working branch tip (${p.branch})` : 'Working branch tip';
    case 'promoted': return `What an earlier environment runs${d}`; // "(what test runs)"
    case 'explicit': return 'Commit you entered';
    default: return 'Chosen by the server';
  }
}
```

### 4.5 ReleaseSheet changes

```tsx
const releasePath = !!w && places.length > 0;              // (A): the waiting run's commit is fixed
const waitingCommit = w?.commit || null;                    // '' means none
const [typed, setTyped] = useState('');
const entered = typed.replace(/\s+/g, '').toLowerCase() || null;   // normalise only; never send ''
const [settled, flush] = useDebounced(entered, 400);
const settling = !releasePath && entered !== settled;
// What the preview is asked about: the waiting run's commit on (A); on (B) the entered one, else today's w.commit, else none.
const asked = releasePath ? waitingCommit : (settled ?? waitingCommit);
const preview = useDeployPreview(projectId, env, asked, !status.isPending);
const showsWaiting = !!asked && asked === waitingCommit && !settled;
const previewBlocked = status.isPending || settling || preview.isPending || preview.isError;
```

- **Confirm:** `disabled={!!reason || previewBlocked}` (this replaces `status.isPending`, which `previewBlocked` contains).
  `loading={pending}` as today. While `previewBlocked` is the only reason, add a quiet status line: "Checking which commit
  will be built…". On error the ErrorBox explains it.
- **go():**
  ```ts
  if (releasePath) release.mutate(chosen.map((p) => p.runId), { onSuccess: answered });   // unchanged
  else {
    const p = preview.data;
    if (!p) return;                                            // cannot happen while confirm is enabled
    const body = settled
      ? { env, commit: p.sha }                                 // S1: the full SHA shown
      : waitingCommit
        ? { env, commit: waitingCommit }                       // today's behaviour, unchanged
        : { env, expectCommit: p.sha };                        // no commit: the server default, guarded
    deploy.mutate(body, { onSuccess: answered, onError: onDeployError });
  }
  ```
  `onDeployError`: when the error is an `ApiError` with code `commit_moved`, call `void preview.refetch()` so the new default
  shows (confirm turns off until it has loaded). The existing deploy ErrorBox shows the server's message. The owner then
  confirms again, against the new preview.
- **Body order** (the Version section, with the "Version" heading kept):
  1. While `preview.isPending`: `<Spinner inline label="Checking the commit" />`.
  2. On success: `<DeployCommitPreview preview={preview.data} sourceText={commitSourceText(preview.data, showsWaiting)} />`.
  3. Deploy path only: the Commit field **right under** the preview, so the details stay visible above an open soft keyboard:
     ```tsx
     <TextInput
       label="Commit (optional)"
       hint="Leave empty to build the commit shown above. Enter a SHA to build that commit instead."
       value={typed}
       onChange={(e) => { setTyped(e.target.value); setRefused(null); }}
       onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); flush(); e.currentTarget.blur(); } }}
       className="font-mono"
       inputMode="text" autoComplete="off" autoCorrect="off" autoCapitalize="none" spellCheck={false}
       enterKeyHint="done" maxLength={64}
       aria-describedby={preview.isError ? 'release-commit-error' : undefined}
       aria-invalid={preview.isError && !!settled ? true : undefined}
       data-testid="release-commit-input"
     />
     ```
     Pressing Enter never submits the deploy. It only applies the value at once and closes the keyboard.
  4. On error: `<div id="release-commit-error" data-testid="release-commit-error"><ErrorBox error={preview.error} onRetry={...} /></div>`.
     `ErrorBox` is `role="alert"`, so the error is announced. Offer `onRetry` (`void preview.refetch()`) for a network error,
     a 5xx or a 409 (`commit_unresolved`: the workstation was offline or did not answer in time; trying again helps). No
     retry for a 400 or 422: retrying a rejected SHA is pointless.
  5. Release path only: `<p className="text-xs text-muted" data-testid="release-commit-fixed">This release was prepared for this commit. To build another one, cancel it under Releases, then deploy again.</p>`
- The "What changed", "Where to", backup, rules, refused and the existing `ErrorBox` (release and deploy errors) stay as they
  are, after the Version section.

### 4.6 MSW mock (`handlers-releases.ts`)

```ts
http.get(`${A}/projects/:id/delivery/deploy/preview`, ({ request }) => {
  const commit = new URL(request.url).searchParams.get('commit');
  if (commit && !/^[0-9a-f]{7,64}$/.test(commit))
    return HttpResponse.json({ error: { code: 'validation_error', message: 'request validation failed' } }, { status: 400 });
  if (commit === 'deadbee')
    return HttpResponse.json({ error: { code: 'commit_unknown', message: 'commit deadbee is not in web' } }, { status: 422 });
  const sha = (commit ?? 'a1b2c3d4e5f6').padEnd(40, '0');
  return HttpResponse.json({ env: 'production', repo: 'web', branch: 'main', sha, shortSha: sha.slice(0, 7),
    subject: 'Release 0.9.4', author: 'Sam', committedAt: ago(30),
    source: commit ? 'explicit' : 'working-branch', sourceDetail: commit ? null : 'tip of main' });
}),
```

`api()` in `api/client.ts` turns `{ error: { code, message } }` into `ApiError(status, code, message)`, so the mock uses that
envelope, exactly as the server does.

### 4.7 Data model and API

There is no web data model change. The web app consumes the landed GWP-257 contract (section 2.5) and sends the existing
`DeployRequest`, now with `expectCommit` on the empty-field path.

### 4.8 Risks

| Risk | Handling |
|---|---|
| The default moves between preview and confirm (a push to the working branch while the sheet is open). | Closed by `expectCommit` (4.5): the server refuses with 409 `commit_moved`, nothing is created, the web refetches the preview and the owner confirms again. |
| The preview asks a workstation, so it can take seconds, or fail with 409 `commit_unresolved` when the workstation is offline. | Confirm waits (spinner). The ErrorBox shows the server's reason and has Try again. This blocks releases on path (A) too, which requirement 4 and AC5 intend. |
| The preview resolves for the first target only; a deploy to several targets on different workstations resolves per target. | Both read the same repository and branch, so they agree in practice. With the field empty, `expectCommit` refuses if any target resolves elsewhere. |
| `subject`/`committedAt` can be null. | Shown as "No commit message" / no date (4.4); confirm is not blocked. |
| Existing release-path tests assumed confirm was enabled right after status loaded. | `route()` serves a preview by default. The tests already wait with `waitFor(() => expect(btn).toBeEnabled())`. |
| Debounce timing in tests | Real timers and `findBy…`/`waitFor` with `{ timeout: 2000 }` (debounce 400 ms). |

## 5. Acceptance criteria → design

| AC | Where it is met |
|---|---|
| Opening the deploy screen shows the commit (short SHA, subject, date, source) before confirm can be pressed | 4.4 and 4.5: the preview is fetched on open on both paths, and confirm is gated by `previewBlocked`. Test T1. |
| Empty field: shown commit = server default, and the deploy builds that SHA | 4.5: `asked = null` previews the server default; `go()` sends no `commit` and `expectCommit = preview.sha`, and the server uses the same `resolveDeployCommit`, refusing if the result differs. Tests T1, T4, T7. Manual check on a dev environment. |
| Valid SHA: shown commit updates, and confirm deploys exactly that SHA | 4.5: debounced `settled` is passed to the preview, and `go()` sends `preview.data.sha` (S1). Test T3. |
| Invalid or unknown SHA: inline error from the server, confirm disabled | 4.2 (the server's message, with `validation_error` reworded) and 4.5 (ErrorBox under the field, `previewBlocked`). Test T2b. |
| Confirm disabled while the preview loads or failed | 4.5 `previewBlocked` (also covers the debounce window). Tests T1 and T2. |
| RollbackSheet unchanged | No file touched. The existing RollbackSheet tests stay as they are and pass (T6). |
| releases.test.tsx extended, all web tests pass | Section 6. Run `pnpm --filter @aom/web test` (unit only). |

## 6. Tests (`apps/web/src/test/releases.test.tsx`)

Fixture: add `preview?: (url: string) => Response | unknown` to `route()`. By default it answers
`json(previewBody(commitParam))` (the 4.6 body shape: `sha`, `shortSha`, `subject`, `committedAt`, `source`, `sourceDetail`)
for any URL containing `/delivery/deploy/preview`. Put this branch before the generic `method === 'POST'` and `json({})`
fallbacks. Add a `noWaiting` status variant: `waitingRelease: null` and an empty queue, for the deploy path.

| # | Test | AC |
|---|---|---|
| T1 | Deploy path: the sheet shows a spinner and confirm is off. After the preview: short SHA (`release-version`), `title` = full SHA, subject, date, source "Working branch tip (main)". Then confirm is on. | 1, 2, 5 |
| T2a | Preview answers 500 (and, separately, 409 `commit_unresolved`): the ErrorBox (`release-commit-error`) shows with Try again, and confirm is off. | 5 |
| T2b | Typing `zz12` gives a 400 `validation_error` (reworded message shown) and typing `deadbee` a 422 `commit_unknown` (server message shown), each inline, and confirm stays off. Clearing the field brings back the default preview and turns confirm on. | 4 |
| T3 | Typing ` A1B2C3D ` sends the preview request with `commit=a1b2c3d` (normalised, after the debounce). The preview shows "Commit you entered". Confirm POSTs `/delivery/deploy` with `{ env: 'production', commit: '<full sha from preview>' }`. Also: while typing (before the debounce), confirm is off. | 3, 5 |
| T4 | Empty field: the confirm POST body is exactly `{ env: 'production', expectCommit: '<full sha from preview>' }` (no `commit` key, never `''`). | 2 |
| T5 | Release path: the preview is requested with `commit=a1b2c3d4e5f6`, the source reads "Waiting for release", there is no `release-commit-input`, and the POST is still `/api/delivery/release` `{ runIds: [U(9)] }`. The existing ReleaseSheet tests pass with the default preview fixture (adjust the first to `findByTestId('release-version')`). | 1, unchanged release flow |
| T6 | The RollbackSheet tests stay unchanged and pass. | 6 |
| T7 | Empty field, deploy answers 409 `commit_moved`: the message shows, the preview is requested again, and the new SHA shows. | 2 |

Also run the RoleBuilder tests if `useDebounced` moves. Leave the E2E suites to the testers (`e2e/tests/environments.spec.ts`
opens the sheet in mock mode and needs the MSW handler from 4.6).

## 7. Assumptions about GWP-257, checked against the landed code

| # | Assumption | Result | Evidence |
|---|---|---|---|
| 1 | Preview endpoint `GET /api/projects/:id/delivery/deploy/preview?env=<env>[&commit=<sha>]`, Owner/Admin, synchronous 200. | **Holds.** Also takes an optional `target` (not used). | `apps/server/src/routes/delivery.ts` (route, 403 for other roles), `DeployCommitPreviewQuerySchema`. |
| 2 | DTO `DeployCommitPreview` from `@aom/shared` with `commit`, `shortCommit`, `subject`, `committedAt`, `source: release \| working-branch \| explicit`, optional `branch`/`version`/`author`. | **Did not hold.** Fields are `sha`, `shortSha`; `subject`, `committedAt`, `author`, `branch`, `repo` are nullable; there is no `version` but a `sourceDetail` in words; `source` also has `promoted`. | `packages/shared/src/api/delivery.ts` `DeployCommitPreviewSchema`. Updated in 4.2, 4.4, 4.6, section 6. Subject and date are present (nullable), so AC1 is not blocked. |
| 3 | Unknown or invalid commit is a 4xx with `{ error: { code, message } }` in plain words. | **Holds.** 422 `commit_unknown`, 422 `commit_ambiguous` in plain words; a bad format is 400 `validation_error` ("request validation failed"), reworded by the hook. | `resolveDeployCommit` `fail()`, `apps/server/src/app.ts:390`. |
| 4 | Preview and deploy share the resolution, a deploy with no commit builds what the preview showed, an Owner/Admin full SHA is accepted. | **Holds.** Both call `resolveDeployCommit`; a human's commit is resolved through it and the run builds `r.sha`. The `promoted` source now gets its own label (4.4). New: `expectCommit` guard, used in 4.5. | `apps/server/src/delivery/runs.ts` `requestDeployRun` (`resolveHere`), `previewDeployCommit`. |
| 5 | Previewing a waiting run's commit (`?commit=<w.commit>`) works like any explicit commit. | **Holds.** It resolves as `explicit`; the web shows "Waiting for release" instead. | `resolveDeployCommit` `a.explicit` branch. |

## 8. Recommendation

Build A1 + P1 + S1 as above, on the landed GWP-257 route and DTO, with `expectCommit` on the empty-field deploy. The size
is about 150 to 220 changed lines (the hook, a small component, ReleaseSheet edits, the mock, tests and docs), within one
module, so it is not large.
