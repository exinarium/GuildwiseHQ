# GWP-105: ceo-chat "Archive all" fails in the full E2E run

## Question

`e2e/tests/ceo-chat.spec.ts`, test *"Archive all closes the other chats and leaves the live CEO chat open"*, passes when
run on its own and fails in the full run on release/1.5.0. Is the cause (a) a product bug in Archive all, (b) a
test-isolation defect, or (c) a timing problem, and what is the fix?

## Answer in short

**(b) Test isolation.** The test picks its chat partners **by name** (`Grace`, `Linus`) from `GET /api/agents`. An
earlier spec, `core-loop.spec.ts` AC8 (*"firing a builder holding a card releases it..."*), fires **whichever builder
claims the card first**: Ada or Grace. Which one wins depends on the run. When Grace is the one fired:

- `GET /api/agents` still returns her (retired agents are listed, sorted last: `apps/server/src/queries/agents.ts`,
  `ORDER BY a.status = 'retired', ...`), so `agents.find((x) => x.name === 'Grace')` succeeds;
- `POST /api/chats` with her id returns **404 `agent not found`**, because `createChat` only accepts
  `status <> 'retired'` agents (`apps/server/src/commands/chats.ts`, `createChat`);
- the test fails at `expect(made.ok(), await made.text()).toBe(true)`, **before Archive all is ever clicked**.

Archive all itself (server command, client hook, drawer) is not at fault. The fix belongs in the test only.

## Evidence

### run.log

`/home/exinarium/devbox-cache/gwp99-run/run.log` is outside the folders the investigation could read (it was also not
readable at planning). A copy was requested from DevOps. The builder or tester should attach the failing assertion from it
to the card. The expected failure is at the `made.ok()` line of the Archive all test with the body `agent not found`,
not at the `expect.poll` line.

### Reproduction observed on this workstation (full run, 2026-11-04 ~20:39 SAST)

A full E2E run was in progress on this workstation during the investigation (`/tmp/aom-e2e/server.log`, same commit
`caa6a44f` as release/1.5.0). Its request log for the ceo-chat spec shows, in order:

| Log line | Request | Result |
|---|---|---|
| 13453 | `POST /api/ceo/chat` (test 1 opens /ceo-chat) | 200 |
| ... | `GET /api/ceo/chat/state`, `POST /api/ceo/chat/new` (test 2, New chat) | 200 |
| ~13470 | `GET /api/agents` (test 3, find Grace and Linus) | 200 |
| 13477 | `POST /api/chats` (first loop pass, Grace) | **404 in 1.1 ms** |
| 13480+ | `POST /api/auth/login` x2, `GET /workstations` | the next spec (devops) starts |

So exactly one chat creation was attempted, it was refused, and the test ended there. No `/api/chats/archive-all`
request was ever sent in that run. Earlier in the same run (log line 10511) the one agent retirement in the admin's
organization is `POST /api/agents/e83e9409-.../fire`, issued by core-loop AC8. The other agent mutations before ceo-chat
(`rehome`, `PATCH`) belong to other organizations' specs. `createChat` returns 404 only when the agent is retired or the
caller may not direct it, and the admin is the organization Owner, who may direct every agent. Therefore the fired
builder in that run was Grace.

### Why it "passes on its own"

Both runs include core-loop (ceo-chat depends on auth, pairing, core-loop, desk and chat), so the defect is the same. Only
the outcome of AC8's race differs. Which builder claims "Fire the holder" first depends on dispatch timing and on
the shifts that ran before. In the full run the phase-2 specs (discovery, boardroom, release-docs-prep, run-steps,
storage, workstation-retire, ...) and phase-3 specs (environments, mobile, mobile-board) run first and change both. On its
own, Ada usually holds the card, Ada is fired, and Grace survives.

### Hypotheses from the card, ruled out

- **(a) Product: a second open CEO chat or a chat left out of the scope.** `archiveAllChats` uses the same visibility
  filter as `listChats` (creator or active project member, agent not retired, not deleted), minus archived chats, the
  `except` list and the `ceo_settings.chat_thread_id` thread. Every listed non-CEO chat is archived in one
  transaction. The only background creator of `kind='chat'` threads is `ensureCeoThread` (CEO role), and test 2
  already asserts there is exactly one open CEO chat. In the observed run the archive request was never reached.
- **(a) Product: list not refreshing.** `useArchiveAllChats` invalidates `['chats']` on settle. Not involved here.
- **(c) Timing.** The poll already waits up to 30 s. The failure is a deterministic 404 on chat creation, not a slow
  assertion.

## Options

| Option | What | Verdict |
|---|---|---|
| 1. Pick partners by state, not name | From `GET /api/agents` take active, non-DevOps, non-CEO agents (at least two). Track the thread ids the test creates and assert on those. | **Recommended.** Independent of which builder core-loop fires. Same data footprint as today. |
| 2. Hire the test's own two agents | `POST /api/agents` (mock runtime) in beforeAll | Rejected. It adds builders and reviewers to the admin's organization, where later specs (devops onward, hr, polish, ...) claim cards and count agents. That risks new failures elsewhere (AC: no other spec newly fails). |
| 3. Make core-loop AC8 deterministic (always fire Ada) | Change the other spec | Rejected as the fix. ceo-chat would still depend on another spec's leftovers, which the constraints forbid ("each test owns its data"). |
| 4. Filter `agents.find` by `status === 'active'` only | Minimal change | Not enough. It still hard-codes names: with Grace retired there is no active Grace, so the test still fails, only with a clearer message. |

## Design (test-only change)

**File:** `e2e/tests/ceo-chat.spec.ts`, the third test. No product code, no `e2e/support` helper change, no shared contract
change. GWP-103 (which edits `e2e/support/*`) therefore does not overlap, and no grouping is needed.

1. **Know the live CEO chat.** In test 1 (or at the top of test 3) record the standing CEO thread id: the uuid at the end
   of the `/ceo-chat/<id>` URL, or the single open `ceoChats()` entry (test 2 asserts there is exactly one).
2. **Choose partners by state.**
   ```ts
   const agents = (await (await api.get('/api/agents')).json()).agents as any[];
   const partners = agents.filter((a) => a.status === 'active' && !a.isDevops && a.roleKey !== 'ceo').slice(0, 2);
   expect(partners.length, `two active agents to chat with: ${agents.map((a) => `${a.name}:${a.status}`).join(', ')}`).toBe(2);
   ```
   Agent names must be distinct for the drawer rows (`chat-row-${agentName}`). If two active agents share a name, take
   the next one with a different name.
3. **Create the chats and keep their ids.**
   ```ts
   const created: { threadId: string; agentName: string }[] = [];
   for (const a of partners) {
     const made = await api.post('/api/chats', { data: { agentId: a.id } });
     expect(made.status(), await made.text()).toBe(201);
     created.push((await made.json()).chat);
   }
   ```
4. **Wait on the UI, not on time.** After `page.goto('/desk')` and opening the drawer, wait until every created chat's row
   (`drawer.getByTestId(`chat-row-${c.agentName}`)`) is visible before clicking `archive-all-chats`. The button count then
   reflects the created chats.
5. **Wait on the request.** Start
   `page.waitForResponse((r) => r.url().endsWith('/api/chats/archive-all') && r.request().method() === 'POST')`
   before clicking the confirm button, then assert status 200 and `archived >= created.length`. Use `>=`: chats
   that earlier specs left in projects the admin can see (for example chat.spec's Linus chat) are archived too, and that
   is correct.
6. **Assert the server state (keep the full strength).** Poll `GET /api/chats` until:
   - every `created` thread id is present with `archived: true` (archived, not deleted);
   - the open list is exactly the live CEO chat: `open.map((c) => c.threadId)` equals `[ceoThreadId]` (stronger than
     today's `['ceo']` role check, and it keeps the "everything else is archived" meaning).
7. **Assert the UI without a reload** (no `page.reload()` or `goto` after the click):
   - `drawer.getByTestId('archive-all-chats')` has count 0 (kept from today);
   - each `chat-row-${c.agentName}` of the created chats has count 0 in the Active view;
   - the CEO row is still visible in the Active view;
   - switch the drawer to the Archived view (the segmented control labelled `Archived (n)`) and expect each created chat's
     row to be visible there.
8. Update the spec's header comment so it no longer assumes Grace and Linus exist. Optionally fix the stale line-9
   comment in `desk.spec.ts` ("Ada and Grace ... are still hired": one builder is fired in core-loop AC8).

Not allowed and not needed: `test.skip`, `fixme`, retries, `waitForTimeout`.

### Risks

- If fewer than two active, directable agents remain in the admin's organization when ceo-chat runs, step 2 fails with a
  clear message. Today core-loop leaves at least Linus and one builder active, and devops/hr (which hire and fire more)
  run after ceo-chat.
- The Archived view selector: check its accessible name in `ChatDrawer.tsx` (a segmented control with values
  `active`/`archived`). Use a role-based locator that does not depend on the count in the label.

## Acceptance criteria mapping

| AC | How it is met |
|---|---|
| Root cause written on the card with evidence | This report: (b) isolation. The evidence is the live full run's server log (404 on `POST /api/chats` for Grace, no archive-all request, core-loop's fire earlier) plus the code paths. Add the run.log excerpt when DevOps supplies it. |
| Full run passes the test in the same order/setup | The partners no longer depend on which builder core-loop fires. Verified by DevOps's full run (the app does not run on the builder's workstation: standing order). |
| Passes alone and in 3 consecutive full runs | Same reasoning. DevOps runs `--project=ceo-chat` once and the full suite 3 times and attaches the logs. |
| Still checks archived, gone from the active list, present as archived, UI without reload | Steps 6 and 7 (stronger than today: thread ids, Archived view, CEO row stays). |
| No skip/fixme/retries/fixed sleeps | Waits are on rows, the archive-all response and `expect.poll`. |
| Product change needs an automated test | No product change. Not applicable. |
| No other spec newly fails | Only ceo-chat.spec changes, and it creates no new agents (option 2 rejected for this reason). |

## Reproducing deterministically (for the tester)

Before the fix, in a stack where ceo-chat's dependencies have run, retire Grace before ceo-chat starts (or let core-loop
AC8 fire her). The test then fails at `made.ok()` with `agent not found`. After the fix it passes either way. A forced
repro on the e2e test database only:
`UPDATE agents SET status='retired', retired_at=now() WHERE name='Grace' AND status='active';`
