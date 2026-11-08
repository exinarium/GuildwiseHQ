# GWP-133: Runner-offline flow: redact mail errors on desk Resend, recover a journey case after a final mail failure

Base checked: `release/1.6.0` = `b648d067` (the card branch starts there). Repository: GuildwiseHQ only. No database migration needed.

## 1. The question

Follow-ups from the GWP-68 review of the runner-offline secure-link flow:

- **R1** The desk Resend lets a raw SMTP/nodemailer error reach the logs. These errors often quote the recipient.
- **R2** A journey case whose secure-link mail fails for the 5th time leaves the client with a dead link. The desk notice then gives an instruction that cannot work.
- **R3** Small UX and cleanup items: (a) desk buttons by role, (b) the firm's name on the public offline panel, (c) the leftover `void c`.

The owner asked for a check of the current code first, so that only the open items get built.

## 2. Check of release/1.6.0 (done / not done)

| Item | State on b648d067 | Evidence |
|---|---|---|
| R1 desk Resend | **Not done** | `apps/server/src/commands/forms-offline.ts:659-667`: `await ctx.mailer.send(...)` has no try/catch around it. A transport error reaches the Fastify handler (`apps/server/src/app.ts:374-382`) as a 500. That handler runs `app.log.error({ err }, 'unhandled error')` **and** `reportServerError(ctx, req, err)`, so the message goes to the log and to the bug intake. The logger's `email` redaction only covers a key named `email`, not text inside `err.message`. There is a second problem: lines 635-657 add 1 to `resends` and append `FormOfflineLinkResent` *before* sending. A failed send therefore still records a resend and uses up one of the 3. |
| R1 automatic sender | **Mostly done** | `sendOne` (`:470-491`) wraps decrypt, URL, firm name and `mailer.send` in a try/catch and logs only `{ requestId, keyUnreadable }`. The retry count (`:524-535`) and the final-failure notice (`:525-529`) are in place. The outer `sendDue` catch (`:385-387`) still logs a raw `err`. Today only DB errors reach it, and none of them carry the address. Even so, nothing guarantees that. |
| R2 journey after final failure | **Not done** | `sendOne` step 3 (`:442-460`) revokes the wait's personal link and re-points the wait to the new offline link *before* the mail is tried. After 5 failures, `closeCase(failed)` (`:527`) deletes the address and the desk notice says "Ask the client to open the form again." (`packages/shared/src/forms/offline.ts:64`). That cannot work for a journey client, because their personal link is revoked. Public-URL and non-journey personal-link cases are fine: their origin link is never revoked (`apps/server/src/public-forms/offline.ts` only stores `origin_link_id`), so the client can open the form again. |
| R3a desk buttons by role | **Not done** | `apps/web/src/components/desk/FormOfflineLinkBlock.tsx:111-138` shows Show email, Resend link and Cancel to everyone. The server already refuses non-admins: the routes use `requireOrg(..., { min: 'admin' })` in `apps/server/src/routes/forms-offline.ts:13-14`, plus `ownerOrAdmin` in the commands. |
| R3b firm name on the offline panel | **Not done** | `apps/web/src/public-form/PublicFormPage.tsx:375` passes `firm={phase.dto.form.settings.title}`. `PublicFormDto` (`packages/shared/src/forms/public.ts:269-281`) has no firm name; its comment says the page uses the form title on purpose. The mail uses `organizations.name` (`firmName()`, `forms-offline.ts:545-548`). |
| R3c `void c` | **Not done** | `forms-offline.ts:674` `const c = await openCase(...)`, `:692` `void c;`. |

**Result:** none of the items is fully done. All of them are to be built. The automatic sender only needs the small outer-catch change and a test.

## 3. Findings and options

### R1 desk Resend: send order

The comment at `:634` says *"count first, so a failing mail server cannot be used to send without limit"*. Counting before sending makes the limit safe against races: two parallel requests cannot both pass when the count is 2. That safety has to be kept. The options:

| Option | Race-safe limit | Failed send uses a resend | Event on failure | Notes |
|---|---|---|---|---|
| A. Send first, then count | No: N parallel requests at count 2 can all send | No | No | Breaks the limit |
| B. Count + event first (today) | Yes | **Yes** | **Yes** (`FormOfflineLinkResent`) | Violates the card |
| **C. Reserve, send, then confirm or release** | Yes | No | No | Recommended |

**Option C:**
1. Reserve: `UPDATE ... SET resends=resends+1 WHERE id=$1 AND resends < $3 AND status='sent' RETURNING resends`. This is the same statement as today, but **without** the event. No row back means `resend_limit`, as today.
2. Send, inside try/catch.
3. On success, append `FormOfflineLinkResent { n }` in its own `withAppendTx`. The event shape and its text are unchanged.
4. On failure:
   - Release: `UPDATE form_offline_requests SET resends=resends-1, updated_at=$2 WHERE id=$1 AND resends > 0`.
   - Log `ctx.log.warn({ requestId: c.id }, 'offline form link resend failed')`, the fixed message with the case id only.
   - Throw `new HttpError(503, 'mail_failed', 'The link could not be sent. Try again later.')`.

   An `HttpError` takes the handler's first branch (`app.ts:361-365`): no log, no bug-intake report, and the body is `{ error: { code, message } }`.
   - Never pass `err` to the log, never put its message in the response, and do not `throw err` again.

If the process dies between the reserve and the release, the resend stays used up. That fails safe and matches today's intent. The status, the held address and the link are not touched, so the case stays open and a later Resend works normally.

### R1 automatic sender

The inner catch is right. Change the `sendDue` outer catch (`:386`) to log no raw error object:

```ts
} catch (err: any) {
  ctx.log.error({ requestId: d.id, code: err?.code ?? null }, 'offline form link failed');
}
```

(`code` is a pg SQLSTATE or a Node code, never text.) Leave the `closeFinished` catch (`:350`) and the `onReconnect` catch (`:561`) as they are: they never touch the mailer or the address. The retry count, the backoff and the final-failure notice stay unchanged.

### R2 journey after a final failure

| Option | What changes | Risk |
|---|---|---|
| **A. Notice points to the instance's "Send a new link"** (card's preferred) | Notice text only (shared). `resendLink` already works on this wait. | Very low. Text only, no change to the flow, events or schema. |
| B. Revoke the personal link and re-point the wait only after the mail went out | Moves the step-3 wait update into the success transaction of `sendOne` | Medium. `closeFinished` (b/c, `:317-320`) closes a case whose `link_id` differs from the wait's `link_id` as `link_replaced`. A `held` case after one failed try would then close itself, so that check would have to be changed too. Two live links would exist per client in the meantime. The existing journey test asserts the current order. |
| C. On final failure, call `refreshLink(force)` automatically | New export from waits.ts, plus a second desk item / webhook call that nobody asked for | Low to medium. Webhook firms get an unexpected extra `JourneyWaitLinkSent`. |

**Chosen: option A.** I checked that "Send a new link" (`POST /api/journey-waits/:waitId/resend-link` → `resendLinkCmd` → `resendLink` → `refreshLink(force=true)`, `apps/server/src/journeys/waits.ts:482-537`) works in exactly this state:
- After a final failure the wait is still `open`/`escalated`, `kind='form'`, and the instance is `waiting`. `closeCase` does not touch the wait or the instance, so `resendLink` passes its guards.
- `refreshLink(force)` revokes the current link (the never-sent offline link), creates a fresh `client`-purpose link (14 days) and delivers it the way the wait is configured: `via:'desk'` gives a "Send the personal form link to …" desk task; `via:'webhook'` gives a `JourneyWaitLinkSent` for the firm's system. In both cases the instance page shows the new **Client link** URL (`listInstanceWaits` → `linkUrl`).
- The failed case is already closed, so `closeFinished` ignores it and the new link does not make it `link_replaced`.
- The address was deleted on final failure, so the desk or the firm's system delivers the link, not our mail. The notice must say so.

The button on the instance page is labelled **"Send a new link"** (`InstanceWaitPanel.tsx:144-146`), not "Resend link", so the notice uses that wording. The desk notice already has an **Open the journey** link (`FormOfflineLinkBlock.tsx:82-89`, from `data.instanceId`).

**Design:** add an explicit flag to the notice input, so that the text does not depend on `journeyName` being found:

```ts
// packages/shared/src/forms/offline.ts
export interface OfflineNoticeInput {
  ...
  /** The case belongs to a journey wait: the client's earlier personal link no longer works. */
  journey?: boolean;
}
...
case 'failed':
  return {
    title: `Secure link not sent: ${c.formTitle} (${who})`,
    body: c.journey
      ? `We could not email the secure link${where}. The email address has been deleted and the client's earlier link no longer works. Open the journey and press "Send a new link" on the waiting step, then send the new link to the client yourself.`
      : `We could not email the secure link${where}. The email address has been deleted. Ask the client to open the form again.`,
  };
```

In `raiseCaseAlert` (`forms-offline.ts:171-178`), pass `journey: !!c.journey_wait_id`.

Apply the same journey sentence to `hold_expired` as well: `...have deleted the email address.` followed by ` Open the journey and press "Send a new link" on the waiting step to get a new link for the client.` when `c.journey`. A journey case can reach hold-expiry after one to four failed tries, with its personal link already revoked. The extra sentence is harmless when the link was never revoked. Leave the non-journey texts byte-for-byte unchanged. No event, audit or schema change.

### R3a desk buttons by role

The web already has the hook: `useCanManageOrg()` in `apps/web/src/lib/orgRole.ts` (Owner or Admin of the active org, from `/auth/me`). That is exactly the server's `ownerOrAdmin` and `min: 'admin'` check. In `FormOfflineLinkBlock`:

```tsx
const canManage = useCanManageOrg();
...
{sent && (canManage || data.waitId) && (
  <div className="sticky-actions ...">
    {data.waitId && <Button ...>Continue journey</Button>}   // unchanged: server checks mayManage
    {canManage && (<>Show email · Resend link · Cancel</>)}
  </div>
)}
```

- Do not render an empty sticky bar for a member on a public-URL case.
- "Continue journey" is outside R3a; its server gate (`mayManage`) is different, so it stays as it is.
- Server checks stay as they are.

### R3b firm name on the public offline panel

Add the firm's name to the public form view. It is public-safe: it is the firm's own published form, and the secure-link mail sends the same name to the client.
- `packages/shared/src/forms/public.ts` `PublicFormDto`: replace the stale comment line with `/** The firm's name (organization name), shown on the offline panel; null when empty. */ firmName: string | null;`.
- `apps/server/src/public-forms/routes.ts` `GET /api/public/forms/:publicId` (`:510-541`): read `SELECT name FROM organizations WHERE id=$1` for `pub.orgId`, and set `firmName: (name ?? '').trim().slice(0, 120) || null`. A single query on a route that is already rate-limited. Expose no other organization field.
- `PublicFormPage.tsx:375`: `firm={phase.dto.firmName ?? phase.dto.form.settings.title}`. The fallback keeps today's behaviour when the name is empty. The panel design has no separate form-title slot, so the title is not shown elsewhere.
- `docs/security/public-forms.md`: one sentence under "Runner offline": the public form view carries the firm's name (organization name) for the offline panel, and nothing else about the organization.

### R3c

`forms-offline.ts:674`: `await openCase(ctx, who, id);` without binding. Delete `void c;` at `:692`. The call must stay, because it does the not-found and `case_closed` checks.

## 4. Files to change

| File | Change |
|---|---|
| `apps/server/src/commands/forms-offline.ts` | R1 reserve/send/confirm-or-release in `resendOfflineLink`. `sendDue` catch without raw `err`. Pass the `journey` flag in `raiseCaseAlert`. R3c. Import `HttpError` from `../errors.ts`. |
| `packages/shared/src/forms/offline.ts` | `journey?: boolean`. Journey wording for `failed` and `hold_expired`. |
| `packages/shared/src/forms/public.ts` | `PublicFormDto.firmName`. |
| `apps/server/src/public-forms/routes.ts` | Fill `firmName`. |
| `apps/web/src/components/desk/FormOfflineLinkBlock.tsx` | Hide the three buttons unless `useCanManageOrg()`. |
| `apps/web/src/public-form/PublicFormPage.tsx` | Use `firmName`. |
| `docs/security/public-forms.md` | T-off-2: add "SMTP/transport errors of the secure-link mail are never logged or returned; only a fixed message with the case id". Add the firm-name sentence. |
| `apps/web/src/help/articles/forms.md` (`#offline`) | Add: Resend link, Show email and Cancel are for Owners and Admins. When the secure link cannot be emailed for a journey client, open the journey and press **Send a new link**. |

Search for every other `PublicFormDto` literal and test fixture, and add `firmName` there, so that typecheck passes (web public-form tests, server tests that build one).

## 5. Tests (which test covers which AC)

The server tests are integration tests (DB and Mailpit, `usePublicFormsWorld`). The builder writes them. Testers or DevOps run them under the standing order; name them in the handoff. To make the mailer fail, use `vi.spyOn(ctx().mailer, 'send').mockRejectedValue(new Error(\`550 5.1.1 <${email}>: Recipient address rejected\`))`. `pf.logs` captures the server log lines (see `forms-offline-flow.test.ts:111-133`).

| # | Test (file) | AC |
|---|---|---|
| S1 | `forms-offline-desk.test.ts`: sent case, throwing mailer, then `POST .../resend`. Expect status 503, body `{error:{code:'mail_failed', message:'The link could not be sent. Try again later.'}}`, and that the body has no `@`, `550` or `stack`. The `pf.logs` slice has `offline form link resend failed` with the case id, and neither the address nor `Recipient`. The row is still `status='sent'` with `email_enc` set and `resends=0`. No `FormOfflineLinkResent` event. Then restore the mailer: the resend gives `resends:1`, one more mail, one event. | R1 (both) |
| S2 | Existing "at most three times" test still passes: 4 mails, 3 events. | R1 regression |
| S3 | `forms-offline-flow.test.ts`: public-URL case with a throwing mailer, 5 sweeps, with `UPDATE form_offline_requests SET next_attempt_at=NULL` between them. Expect `attempts` going 1→5 and a final `status='failed'` with the address deleted. The notice body contains "Ask the client to open the form again" (unchanged). The logs contain neither the address nor the SMTP text. | R1 auto sender, R2 public-URL unchanged |
| S4 | `forms-offline-flow.test.ts` journey: `formWaitJourney`, `startInstance`, offline request with the personal token, online, 5 failing sweeps. The notice (`subkind='form_offline_hold_expired'`, `subject_key` ends `:failed`) contains `Send a new link` and not `open the form again`. The old personal link loads as revoked. Then `POST /api/journey-waits/:waitId/resend-link`; the `GET .../waits` `linkUrl` is a new link; `pf.load(publicId, newToken)` returns 200; and submitting through it moves the journey on. | R2 (both) |
| S5 | A member calling `/email`, `/resend` and `/cancel` gets 403 (extend the existing member test so it goes through the routes, not only the command). | R3a server |
| S6 | Existing cancel tests pass unchanged. | R3c |
| S7 | `packages/shared/test/forms-offline.test.ts`: `failed` and `hold_expired` with and without `journey`. The non-journey text is unchanged. | R2 |
| S8 | `public-forms-*` route test: the `GET /api/public/forms/:id` body has `firmName` equal to the org name, and no other org field. | R3b |
| W1 | `apps/web/src/test/instance-wait-offline.test.tsx`: the fetch stub must answer `/api/auth/me` with `activeOrg.role` (otherwise the existing tests lose their buttons). Render as `owner`, `admin` and `member`: the buttons show only for the first two; the member still sees the details and Continue journey (when `waitId` is set). | R3a |
| W2 | `apps/web/src/test/public-form-offline.test.tsx`: DTO with `firmName:'Smith & Co'` and title `'Rental application'`. The `h2` and the sentences say "Smith & Co"; `firmName:null` falls back to the title. | R3b |
| W3 | Existing instance-wait-offline tests pass. | last AC |

Run lint (`biome`), typecheck, and the shared and web unit suites. Leave the server integration suites (the DB-backed `forms-offline-*`, `public-forms-*` and `journey-waits*`) for the testers.

## 6. Risks

- **Bug intake:** before this change, a desk Resend failure created a 500 bug report that carried the error. After it, no report is made (it is now a handled 503). That is intended.
- **Release after crash:** if the process dies between the reserve and the release, the resend stays used up. That fails safe, and it is the same outcome as today.
- **Public DTO change:** `firmName` is a new field. The web build and the server ship together, and the fallback covers an older cached page.
- **Notice wording:** the "Send a new link" label must match `InstanceWaitPanel.tsx`. If that button is renamed later, the notice must change with it.
- **Member view:** the desk must also show the read-only details to Members. They could see them before; only the buttons disappear.

## 7. Acceptance criteria → design

| AC | Covered by |
|---|---|
| Check recorded for R1, R2, R3a-c | §2 (none fully done; all built) |
| R1 generic error, no SMTP/recipient/stack, fixed log line | §3 R1 option C, `HttpError(503,'mail_failed')`, S1 |
| R1 case open, email held, no event, later resend works | Release step, event appended only on success, S1, S2 |
| R1 automatic sender clean, retry count and notice kept | Inner catch kept, `sendDue` catch without `err`, S3 |
| R2 notice no longer says "open the form again" for journeys | `journey` flag + new text, S4, S7 |
| R2 instance "Send a new link" gives a working link, 5-failure test | `resendLink` verified in §3, S4 |
| R2 public-URL unchanged | Non-journey text unchanged, S3 |
| R3a buttons by role, server 403 kept | `useCanManageOrg`, W1, S5 |
| R3b firm name on the panel | `PublicFormDto.firmName`, W2, S8 |
| R3c no `void c`, behaviour unchanged | §3 R3c, S6 |
| Lint, typecheck, suites | §5 |
