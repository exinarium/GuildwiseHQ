# GWP-150: Business mode, hide the project Test services panel

## Question

Release 1.4.0 added the Test services panel (`TestServicesPanel`, anchor `#test-services`) to Project settings,
gated on `traits.usesRepos`. The request is to hide it in a Business organization with the GWP-27 condition
`repoUi = usesRepos && !business`, and to make the server's `setTestServices` refuse Business organizations the same
way as "the other dev-only project commands under GWP-27" (`assertDevMode`, 409 `business_mode`).

Step 1 of the card: check the code on release/1.6.0 first and record what is already done.

## Pre-check on release/1.6.0

Checked at `origin/release/1.6.0` = `58e62bbf`. The card branch is at the same commit, so the worktree is the
release code.

| Item | State on release/1.6.0 |
| --- | --- |
| Web: Test services gate | `apps/web/src/pages/ProjectSettings.tsx:453`: `project && traits.usesRepos`. No view term. |
| Web: `repoUi` | `ProjectSettings.tsx:87`: `const repoUi = traits.usesRepos;` with the comment "show whenever the project uses repositories, in every view". `usesRepos && !business` is gone. |
| Web: TOC / links to `#test-services` | None. The `sections` nav (`ProjectSettings.tsx:146-162`) has no `test-services` entry, and nothing else in `apps/web/src` links to it. Only the `div id` and the `PUT /projects/:id/test-services` mutation exist. |
| Server: `setTestServices` | `apps/server/src/commands/projects.ts:451`: schema check, `loadVisibleProject`, project Owner or org Owner/Admin. No mode check. |
| Server: `assertDevMode` / 409 `business_mode` | Not defined anywhere in `apps/` or `packages/`. No server code refuses anything because of the mode. |

So neither the web gate nor the server refusal exists. **But that is because they were taken out on purpose,
not because nobody got to them.**

## Findings: GWP-27 was superseded by "views"

GWP-27 (`8934baf8`, "Organization mode: Developer or Business, with the developer surfaces hidden and refused in
Business mode") did add `repoUi = traits.usesRepos && !business` and the server refusals. Two later commits from
2026-10-31 replaced organization modes with **views**:

- `f14efb4d` feat(server): "views replace organization modes; nothing is refused because of a view". It removed
  "every mode gate (repositories, dev and business hires, packs by git URL, rule packs, playbooks, relay
  integrations, code workflows on cards, ...)". The `projects.ts` change in that commit is part of this.
- `4374d0c5` feat(web): "Software and Business views, user-menu toggle and Build something". It changed
  `ProjectSettings.tsx` from `repoUi = traits.usesRepos && !business` to `repoUi = traits.usesRepos` ("in every
  view"). In the Business view the repositories now sit in a closed fold (`RepoFold`, "Repositories (software)").

The rule is now written down in the project docs and pinned by tests:

- `docs/ARCHITECTURE.md` (Views section): "A view is presentation only; no server code refuses an action because of
  it. ... the former `business_mode_blocked` refusal and `assertDevMode`/`assertBusinessOrg`/`role_not_in_mode`
  gates are gone."
- `docs/USER-GUIDE.md` ("Software view and Business view"): "A view changes what Guildwise shows and the words it
  uses; it never switches anything on or off. Every organization has every feature (repositories, builders,
  reviewers, testers, DevOps, ...)."
- `packages/shared/src/orgs/mode.ts`: `isBusinessView` is "THE gate for every Business-view difference in the web:
  presentation only, never a refusal". `isBusinessOrg` is now only the organization's *default* view, used for
  server text that has no single reader.
- `apps/server/src/orgs/mode.ts`: `orgModeOf` is "a presentation default only: nothing on the server refuses an
  action because of it".
- `apps/server/test/org-mode.test.ts`: "A view is presentation only: nothing on the server is refused because of
  it", plus "(a) every capability is available in every view".
- Also, "Business" is no longer a property of the organization. It is the member's *effective view*
  (`viewOverride ?? mode`), so two members of one organization can see different views.

The card came from a backlog suggestion made during GWP-27, before views landed. Its premises no longer hold:

1. "the same repoUi = usesRepos && !business condition as the other GWP-27 dev-only sections": that condition no
   longer exists. `repoUi` is `usesRepos`, and the Test services block already follows the same gate as the other
   repository sections (Phases, Environments, Reference repos, Merging, Commit as, Full suite, Code map, Architect,
   Manual QA, Owner approval and others are all shown in both views).
2. "refuses with the same status and error shape as the other dev-only project commands under GWP-27": no such
   commands exist any more. There is nothing to match, and adding a refusal would break the documented rule that a
   view never refuses.
3. "in a Business organization": the organization mode is now only a default; the view is per member.

## Options

**o1. Close the card as superseded; build nothing (recommended).**
The owner's views redesign decided that every organization has every capability and that a view only changes
presentation. On release/1.6.0 the Test services panel already follows the same `usesRepos` gate as the other
repository sections. In the Business view the repositories are folded, but the repository-workflow panels are not.
Stored settings, the runner and the API stay as they are. Requirement 4 and its ACs hold trivially.

**o2. Presentation only: hide the panel in the Business view, web only.**
This keeps the views rule (no server refusal) and still declutters the Business view.

- `apps/web/src/pages/ProjectSettings.tsx:453`: change the mount condition to `project && repoUi && !business`.
  `business` is the existing `useBusinessView()` at line 85. No new helper and no second definition. Do **not**
  change `repoUi` itself, because that would hide about ten other sections in the Business view (a wider product
  change than this card).
- No TOC entry exists, so there is nothing to hide. A deep link to `#test-services` finds no element and the browser
  stays at the top of the page. No error: the hash redirect at lines 102-108 only handles `#run` and `#phases`.
- Server, runner and contract unchanged.
- Tests (new file `apps/web/src/test/project-settings-test-services-view.test.tsx`, so no existing test file is
  edited): render `ProjectSettings` (see `repo-less.test.tsx` for the setup) with `me.activeOrg` `{mode:'business'}`,
  then with `{mode:'dev', viewOverride:'business'}`, for a code project with and without a repository. Assert
  `test-services-panel` is absent. In the Software view it is present, and for a research project it is absent in
  both views. `test-services-panel.test.tsx` stays green.
- Cost: it singles out one panel when its neighbours (Full suite, Code map, Manual QA, Merging) stay visible. It
  also cannot meet the card's server ACs (refusal), the "same repoUi condition" AC as written, or the "Business
  organization" wording (it would be the Business *view*).

**o2b. Variant of o2: fold rather than hide**, like `RepoFold` ("Test services (software)"), to match how the
Business view treats repositories. Same files and tests. Assert `test-services-panel` is inside a closed
disclosure rather than absent.

**o3. Build the card as written (hide and refuse by organization mode).**
Not recommended. It brings back a gate of the kind `f14efb4d` deliberately removed. It contradicts ARCHITECTURE.md,
USER-GUIDE.md, the `mode.ts` contracts and `org-mode.test.ts` ("every capability is available in every view"). It
also has no "GWP-27 error shape" to copy, so it would invent a new 409 `business_mode` refusal that the web no longer
handles anywhere.

## Recommendation

**o1: close GWP-150 as superseded by views (`f14efb4d`, `4374d0c5`).** Nothing is left to build that fits the
current product rules. If the owner still wants the Business view decluttered, take **o2** (or o2b), web only, as a
small separate change. Even then, the server refusal ACs should be dropped, not built.

Because this goes against the card's written ACs and a later owner decision, the choice is put to the owner rather
than decided in design.

## Acceptance criteria against the options

| AC | o1 (close) | o2 (hide in Business view, web only) |
| --- | --- | --- |
| Pre-check recorded on the card | Done (this report and the card note) | Done |
| Business: panel not shown (with or without repo) | Not met: the panel shows by design (views rule) | Met for the Business *view* |
| Developer: panel shown, saving works | Met (unchanged) | Met (unchanged) |
| Not usesRepos: hidden in both modes | Met (unchanged) | Met |
| No link/TOC for `#test-services`; deep link harmless | Met (there is none; the deep link is harmless) | Met |
| Same `repoUi` condition, no copy of the logic | Met: it uses the same `usesRepos` gate as the other sections | `repoUi && !business`, both terms reused; not "the GWP-27 repoUi", which no longer exists |
| Server refuses in Business, same shape as GWP-27 | Not applicable: no such refusals exist, by decision | Not met by design |
| Developer: endpoint succeeds, permission checks kept | Met (unchanged) | Met (unchanged) |
| Stored settings untouched | Met | Met |
| Unit tests for both modes; existing panel tests pass | Existing tests pass | New web test file; existing tests pass |

## Out of scope / notes

- Runner (`apps/runner/src/sandbox/test-services.ts`: `decideTestServices`, `testServicesSpec`): no change in any
  option. Because views never switch anything off, saved test services keep applying in every view. That fits the
  views rule, so there is no follow-up.
- No schema change, no data migration and no contract change in any option.
