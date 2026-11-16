# GWP-249: the runner does not forward the size and path options of `aom design`

## Question

When the Architect ends a design shift with `aom design --report <path> --summary "..." --size <n> --path <p>`,
the server should receive the size estimate and record the design sizing and size verdict. It does not. Where is the
value lost, and what is the smallest fix that keeps runners and servers of different versions compatible?

## Findings

The value goes through four steps. Only the third one loses it.

| # | Step | Code | Size kept? |
|---|------|------|------------|
| 1 | CLI parses the flags | `apps/runner/src/aom/aom-cli.ts:833`: `designSizeFlags(p)` when `verb === 'design'` (also `:813` for `aom design revise`) | yes |
| 2 | CLI builds the outcome and posts it to the runner over IPC | `aom-cli.ts:840-851`: `...(size ? { size } : {})` | yes |
| 3 | Runner supervisor checks the report and **rebuilds** the data before sending it to the server | `apps/runner/src/shifts/supervisor.ts:2969` `prepareInvestigation` | **no** (in 2 of its 4 return branches) |
| 4 | Server parses with `InvestigationDataSchema` (`size: DesignSizeDataSchema.optional()`) and runs `designSizeStep` | `apps/server/src/commands/shifts.ts:280, 682-701`, `apps/server/src/commands/design-size.ts:64-103` | yes, reads `inv.size` |

### The planning note was right: the CLI premise in the card is wrong

`designSizeFlags` is already called by the `design` verb. `investigationReport` serves both `aom design` and
`aom investigate`, and the dispatch table maps `design` to it at `aom-cli.ts:2309`. The code-graph edge
"only caller is investigationReport" is accurate, but `investigationReport` *is* the design report. The parser is
already shared, and `apps/runner/test/aom-design-size.test.ts` covers it.

The investigation report (`aom investigate`) **never** forwarded size: `size = verb === 'design' ? designSizeFlags(p) : undefined`.
So the AC "the investigation report still forwards its size and path options unchanged" means: it keeps sending no size,
as it does today. No change there.

### The real bug: `prepareInvestigation` drops `size`

`prepareInvestigation` (supervisor.ts:2969-3105) builds a new `InvestigationData` object field by field in two branches,
and neither one copies `size`:

- **Repository report with a card worktree** (the normal case), lines 3024-3037: copies `assumptions`,
  `noAssumptions`, `review`, `testsOnly`. **No `size`.**
- **Vault report**, lines 3094-3104: the same list. **No `size`.**

The other two branches spread `...data` and so keep `size` by luck:
- `aom design confirm` (lines 2980-2987)
- a repository report written before the card branch exists (detached, line 3075)

`testsOnly` was added to both hand-built lists (BLOCKERS.md section 2, with runner tests
`architect-shift.test.ts:187` and `:203`). `size` (GWP-207) was never added.

### What the owner sees

With a size unit set and a runner at `MIN_RUNNER_FOR_DESIGN_SIZE` (`0.1.75`) or newer, `designSizeStep` refuses every
normal design: `!i.inv.size`, so the error is "this project measures size in ... add --size <n> ... and at least one --path",
even when the Architect passed both. `aom design revise --size ...` in a worktree is refused the same way. Without a size
unit, the design is accepted but the card's sizing has no estimate or paths. That matches the bug report.

### The server is correct

`designSizeStep` reads `i.inv.size.estimate/paths/risk/seams` under the same field names the CLI sends (the
`DesignSizeData` shape: `{ estimate, paths, risk?, seams }`). `apps/server/test/design-size-step.test.ts` and
`design-gate-needs-split.test.ts` already cover the server side. Requirement 5 of the card (a server change) is **not
needed**.

## Options

1. **Add `...(data.size ? { size: data.size } : {})` to the two hand-built objects.** Two lines. Fixes the bug. The next
   field added to `InvestigationData` can be forgotten the same way.
2. **Spread `...data` in the two branches and then override the runner-owned fields.** Simpler, but it also forwards
   `body`, `reportText` and `commit` that the agent might set. Those are runner-owned. The repository branch must not
   forward an agent-provided `body`, and the vault branch must not forward `commit`/`reportText`. This would need an
   explicit delete list, which is the same risk turned around.
3. **One small helper that picks the agent-provided fields, used by both branches (recommended).** The list of
   agent-owned fields sits in one place next to the code that adds the runner-owned ones:

   ```ts
   /** The architect's own fields of the report, forwarded as given (the runner adds the location, commit and text). */
   function architectFields(data: InvestigationData): Partial<InvestigationData> {
     return {
       ...(data.assumptions ? { assumptions: data.assumptions } : {}),
       ...(data.noAssumptions ? { noAssumptions: data.noAssumptions } : {}),
       ...(data.review ? { review: data.review } : {}),
       ...(data.size ? { size: data.size } : {}),
       ...(data.testsOnly ? { testsOnly: true } : {}),
     };
   }
   ```

   Repository branch: `{ reportPath: rel, summary, location: 'repo', commit, reportText, ...architectFields(data) }`.
   Vault branch: `{ reportPath: vaultPath, summary, location: 'vault', ...architectFields(data) }`.
   The result is the same as option 1, with less room to forget a field next time.

## Recommendation

Option 3: a runner-only fix in `apps/runner/src/shifts/supervisor.ts`, plus tests. No CLI change, no shared-schema
change, no server change.

## Design

### Files to change

- `apps/runner/src/shifts/supervisor.ts`: add `architectFields` (a module-level function near `prepareInvestigation`,
  or a private method) and use it in the repository branch (3024-3037) and the vault branch (3094-3104). Do not touch the
  `confirm` and detached branches. They already spread `data`, and changing them is out of scope.
- `apps/runner/test/architect-shift.test.ts`: new tests (see the test plan below).
- `apps/runner/test/aom-cli.test.ts`: CLI payload tests for `aom design --size/--path` (see below). `aom-design-size.test.ts`
  already covers the parser and stays as it is.
- `CHANGELOG.md` under `[Unreleased]` / `### Fixed`: one line, for example "A design's size estimate (`aom design --size
  --path`) now reaches the server. The runner dropped it when it checked the report, so a project with a size unit
  refused every design."
- No doc change: `docs/design/architect-and-workflows.md` §3.6 already describes `--size`/`--path`/`--risk`/`--seam` and
  `InvestigationData.size` as the code has them.

### Data model and API

No change. `InvestigationData.size` (`packages/shared/src/protocol/ipc.ts:144`) is already optional and already in the
server's schema.

### Compatibility

- Older servers: the field is in `InvestigationDataSchema` of every server since GWP-207 (runner 0.1.75 / release 1.8.0).
  A server older than that parses with zod's default object (unknown keys are stripped), so it still accepts the report.
- Newer servers with an old runner: the report has no `size`, and the server's existing rules apply (`required` only
  from runner 0.1.75 on).
- No new capability flag is needed: the field was always meant to be sent, and only the runner dropped it.

### Risks

- The `body` / `commit` / `reportText` fields must stay runner-owned. The helper copies only the five agent fields, so
  this does not change.
- `size` is forwarded as the CLI parsed it. The runner does no extra validation. The server's
  `DesignSizeDataSchema` and `designSizeStep` / `checkedProposal` validate it (seams, budget), as for the other branches
  today.
- Regression search: `prepareInvestigation` has two callers (supervisor.ts:3591 for no-worktree shifts, :3631 for
  worktree shifts). Both only replace `toSend.data` with the result, so both benefit and nothing else reads the dropped key.

### Test plan (runner, unit/harness, no server needed)

In `apps/runner/test/architect-shift.test.ts`, next to the `--tests-only` tests and with the same harness:

1. **Repository report forwards size**: commit the report, post `handoff(data({ size: { estimate: 120, paths:
   ['apps/runner/src/a.ts', 'packages/shared/src/b.ts'], risk: 'medium', seams: [] } }))` and expect status 200. Expect the
   server's `shift.report` to `toMatchObject({ data: { location: 'repo', size: { estimate: 120, paths: [<same order>], risk: 'medium' } } })`.
   This covers AC1, AC2 and AC3 (order kept).
2. **Vault report forwards size**: as in the vault `--tests-only` test, with `size` in the data, expect the
   `size` in the server report.
3. **No size, no field**: a repository report without `size` gives a server report whose `data.size` is `undefined`
   (AC5). The existing test at :52 can get an extra `expect(...data.size).toBeUndefined()`.
4. **Revise in a worktree**: `handoff(data({ review: { decision: 'revise', revised: [1], note: 'x' }, size: {...} }))` with
   `investigation({ review: ... })` in the brief as other revise tests need. Expect `size` in the server report. Skip this
   test if the harness cannot set up a revise shift easily. The helper covers the code path anyway.

In `apps/runner/test/aom-cli.test.ts` (the `setup()` / `t.reports` helper, like the `--tests-only` block at :425):

5. `aom design --report r.md --summary s --size 12 --path a/b.ts --path c/d.ts` gives
   `t.reports.at(-1).data.size` = `{ estimate: 12, paths: ['a/b.ts', 'c/d.ts'], seams: [] }` (AC2, AC3).
6. `--size 12.5 --path a` and `--path a` with no `--size` exit non-zero, `t.reports` length is unchanged, and stderr names
   `--size` (AC4).
7. `aom investigate --report r.md --summary s --size 3 --path a` gives `data.size` `undefined` (AC6: the investigation report
   keeps today's behaviour; it never sent size).

Run: `pnpm --filter @aom/runner test` (vitest), then the repository's typecheck and lint (the handoff checks
run them anyway). The server suite is not affected by the change. Run `apps/server/test/design-size-step.test.ts` once to
confirm it is green.

### Acceptance criteria mapping

| AC | How the design meets it |
|----|-------------------------|
| `--size` and `--path` reach the server and are stored/used | `architectFields` forwards `size` from both rebuilt branches. The server's `designSizeStep` already stores it (tests 1, 2, 4) |
| Same field names and shapes as the investigation report | Correction: the investigation report never sends size. The field is `InvestigationData.size` (`DesignSizeData`), the same object the CLI builds and the server reads. Nothing is renamed |
| Repeated `--path` forwarded in order | `designSizeFlags` keeps order (`many(p,'path')`), and the runner copies the array as it is (tests 1, 5) |
| Invalid `--size` / malformed `--path` exits non-zero, nothing sent | Already true in `designSizeFlags` (UsageError before `report()`). Locked in by test 6 |
| No `--size`/`--path` behaves as before | `designSizeFlags` returns `undefined`, the CLI omits `size`, and the helper adds nothing (test 3) |
| Investigation report unchanged | No change to `investigationReport`. Test 7 locks in that `investigate` sends no size |
| Parsing is shared | Already shared: the `design` verb is `investigationReport`, which calls `designSizeFlags`. No new parser |
| New tests pass, runner and server suites stay green | Tests 1-7. The server code is not touched |

### Note on the card's premise

Requirement 5 (a server change) and the "design report does not reach `designSizeFlags`" claim do not hold. The bug is
in the runner's report check (`prepareInvestigation`), after the CLI has parsed the flags correctly.
