# Design: automations deliver the agent's output (email, webhook, WhatsApp, Google Sheet)

## 1. The question

An automation (a schedule) that starts agent work should be able to send what the agent produced (the result text
and a link back to the card) to email, a signed webhook, WhatsApp or a Google Sheet. Today it can only send fixed
digests. The open points were:

- where to send from, now that agent output only exists after the card's work is done;
- which WhatsApp API and which Google Sheets auth method to use;
- where the WhatsApp and Sheets credentials live.

Owner decisions 3 and 5 (30 Oct 2026, on the card thread and in the standing orders) change requirement 3 of the card:

- the server never stores user credentials or tokens, and never stores WhatsApp message bodies;
- any delivery that needs the user's own credential is sent **by the runner**, with a token kept encrypted on the
  workstation;
- server-side sending stays only where no user credential is involved.

So "stored encrypted the way webhook secrets are (decryptSecret)" applies to the webhook signing secret only. WhatsApp
and Sheets credentials are stored on the runner, never on the server.

## 2. Findings (the code today)

| Topic | Where | What it does |
|---|---|---|
| One action per schedule | `packages/shared/src/events/schedule.ts` `ScheduleActionSchema` | The automations that start agent work are `create_card` (and `regression_run`). `ba_task` wakes the CEO. |
| Delivery record | `ScheduleDeliverySchema` (webhook, email) stored on `schedule_runs.delivery` | It is built inside the action's transaction (`schedule-actions.ts` `executeAction`), before any agent has run. |
| Tries and retry | `schedule-delivery.ts` `attemptDelivery` / `deliverDue` | One `ScheduleDeliveryAttempted` per try. Backoff 1 min, 5 min, 30 min, 2 h, at most 5 tries (`WEBHOOK_MAX_ATTEMPTS`, `webhookBackoffMs`). `single` (a test) never retries. |
| SSRF and signing | `assertWebhookUrl`, `assertResolvesPublic`, `signWebhook`, `postWebhook` | `postWebhook` reads the secret through `webhookSecret(ctx, action)`, which only knows `integration: 'webhook'` actions. |
| History | `projections/schedules.ts`, `schedules.ts` `listRuns`, `web/.../RunHistory.tsx` | Runs and attempts with the error text. `listRuns` types `delivery.kind` as `'webhook' \| 'email'`. |
| Card done | `schedule-triggers.ts` | The event sweep already reads `CardFinalized` (to `done`), `QaPassed` and `QaSkipped` as `card_done`, behind a cursor, idempotent through `schedule_runs (schedule_id, source_key)`. `cards.schedule_id` says which schedule made the card. |
| Agent output text | `HandoffWritten` (`note`, `stage`, `outcome`) → `thread_messages` kind `handoff`. `InvestigationReported` (`summary`, `reportPath`, `location`). | There is no single "result" column. The last agent handoff note of the card is its result. For an investigation-only card it is the report summary. |
| Runner-side sending with the user's credential | `outbound.post` (Jira or GitHub comment) and `integration.run` (issue poll): the server enqueues a durable command (`enqueueRunnerCommand`), the runner calls the provider with its local credential, and `handlers.ts` `applyCommandResult` applies the answer. | This is the pattern to copy. |
| Browser-to-runner credentials | `docs/design/integrations-page.md`: the registry `packages/shared/src/integrations/registry.ts`, the sealed envelope (RSA-OAEP-256 + AES-256-GCM on `RunnerKeys`), and runner adapters in `apps/runner/src/integrations/`. | The server only relays ciphertext. Only the workstation's own user may connect (D4). Credentials are written to `secrets/*.json`, mode 0600, **in plain text** (for example `external/jira-store.ts`). |

Guildwise Cloud (`/home/pieter/src/guildwise-cloud`) does not use `ScheduleDelivery`, `IntegrationKindId` or the
delivery kinds, and nothing in this repository has an exhaustive `Record<>` over them. Adding union members and enum
values is additive and safe.

## 3. Options

### 3.1 When and how the output is sent

| | (A) A `deliverOutput` block on the `create_card` action, sent when the card is done (**recommended**) | (B) A second automation with the `card_done` trigger and a webhook or email action | (C) Send from `afterRun` |
|---|---|---|---|
| Shape for the user | One automation: "make this card, and send me its result". | Two automations to keep in step, plus a filter to match only the first automation's cards. | Impossible: no output exists yet. |
| Output text in the payload | Yes: the server reads it from the card when the card is done. | No: the trigger carries the ref and title, not the text. | No. |
| Reuses retry, history and send test | Yes: one `schedule_runs` row per destination. | Partly. | — |
| Change to existing schedules | None: the field is optional. | None. | — |

### 3.2 WhatsApp provider

| | **Meta WhatsApp Cloud API (recommended)** | Twilio WhatsApp | A third-party BSP (360dialog, ...) |
|---|---|---|---|
| Credential the org enters | Phone number ID and a system-user access token from Meta Business. | Account SID and auth token. | API key. |
| Extra party or cost | None beyond Meta's conversation pricing. | Twilio margin, plus a Twilio account. | Another vendor. |
| Same API as the inbound relay (GWP-37 "Runner WhatsApp Cloud API handler") | Yes: one integration and one credential store. | No. | No. |
| Test destination | Meta's free test number, and the pre-approved `hello_world` template. | Twilio sandbox. | Varies. |

**Choice: Cloud API.** `POST https://graph.facebook.com/<version>/<phoneNumberId>/messages` with a bearer token. Keep
the Graph version in one constant.

**Trap:** a message the business starts outside the 24-hour customer-service window must be a **template** message.
An automation's output is nearly always outside that window. The destination therefore takes an approved template
(name and language) with one body variable. The runner sends `type: 'template'` with the excerpt as `{{1}}`. With no
template set it sends `type: 'text'`, which only works inside the window. Meta's re-engagement error (131047) is then a
**final** failure, with the reason "outside the 24-hour window: set an approved template on this destination".

Template body variables may not hold newlines, tabs or more than four spaces in a row, and Meta's sources disagree on
the length limit (550 or 1,024 characters for the whole body). So the excerpt is flattened (newlines become " · ",
runs of spaces are squeezed) and cut to **500 characters** with "…", followed by the link. The builder checks the
current limits and error codes against Meta's Cloud API documentation, and puts the limit in one constant.

### 3.3 Google Sheets auth

| | **Service account key (recommended)** | User OAuth (refresh token) | Apps Script web app URL |
|---|---|---|---|
| Needs an OAuth flow or client registration | No. The org creates the account in its own Google Cloud project and shares the sheet with the account's e-mail. | Yes: a GuildWise OAuth client, consent and app verification for the sensitive `spreadsheets` scope. That is the excluded cloud-OAuth service (owner decision c). | No. |
| Credential | A JSON key (about 2.3 KB; fits the 8 KB envelope). | Refresh token. | The secret sits in the URL. |
| Access | Only the sheets shared with the account. | The user's whole Drive (scope). | Whatever the script does. |
| Runner code | Sign a JWT RS256 with `node:crypto`, exchange it at `https://oauth2.googleapis.com/token` (grant `urn:ietf:params:oauth:grant-type:jwt-bearer`, scope `https://www.googleapis.com/auth/spreadsheets`), then `values:append`. No new dependency. | Refresh plus append. | It is a plain webhook. |

**Choice: service account key.** The row is appended with
`POST https://sheets.googleapis.com/v4/spreadsheets/<id>/values/<sheet>!A:E:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`.

`RAW` is required. With `USER_ENTERED`, agent text that starts with `=` would become a formula (spreadsheet formula
injection).

### 3.4 Where the runner keeps the credentials

Integrations today write `secrets/*.json` (0600) in plain text, and the owner decision says "stored encrypted on the
workstation".

| | **AES-256-GCM file, key derived from the runner's private key (recommended)** | OS keychain (keytar or libsecret) | Plain 0600 file, as today |
|---|---|---|---|
| Headless VPS, WSL, Codespaces | Works. | Often no keyring daemon; needs a native module. | Works. |
| A copied, synced or backed-up file alone | Useless without `runner-key.pem`. | Protected. | Leaks. |
| Root, or the same user on the machine | Not protected (honest: the same as every other runner secret). | Partly. | Not protected. |

**Choice:** a small shared store, `apps/runner/src/secrets/sealed-file.ts`.

- File format: `{ v: 1, alg: 'A256GCM', iv, ct, tag }`, mode 0600, in the 0700 `secrets/` directory.
- Key: HKDF-SHA256 over the pkcs8 DER of `RunnerKeys`'s private key, salt `guildwise-local-secrets`, info
  `v1:<file name>`.
- `load()`, `save()` and `remove()` as in `JiraCredentialStore`.
- Every loaded secret is registered with `redact.ts`.

GWP-37 (the WhatsApp relay handler, "local encrypted secrets") must reuse this store and the same `whatsapp`
integration entry. It adds its inbound fields (app secret, verify token) to the same instance. Moving the existing
`jira.json` and `git-tokens.json` onto this store is **not** part of this card (backlog suggestion).

## 4. Design

### 4.1 Shared types (`packages/shared`, additive only)

`events/schedule.ts`:

```ts
const E164 = z.string().regex(/^\+[1-9]\d{6,14}$/);
export const OUTPUT_DESTINATION_KINDS = ['email', 'webhook', 'whatsapp', 'google_sheet'] as const;
export const OutputDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), to: z.array(z.string().max(254)).min(1).max(10), subject: z.string().max(200).default('') }),
  z.object({ kind: z.literal('webhook'), url: z.string().min(1).max(2000), format: WebhookFormat.default('generic') }),
  z.object({
    kind: z.literal('whatsapp'),
    workstationId: Id,
    instance: z.string().min(1).max(200),          // the phone number ID of the connected WhatsApp integration
    to: z.array(E164).min(1).max(5),
    template: z.object({ name: z.string().min(1).max(512), language: z.string().min(2).max(15) }).optional(),
  }),
  z.object({
    kind: z.literal('google_sheet'),
    workstationId: Id,
    instance: z.string().min(1).max(200),          // the service account e-mail of the connected Google Sheets integration
    spreadsheetId: z.string().regex(/^[A-Za-z0-9_-]{20,100}$/),
    sheet: z.string().min(1).max(100).default('Sheet1'),
  }),
]);
export const DeliverOutputSchema = z.object({
  destinations: z.array(OutputDestinationSchema).min(1).max(5),
  /** Signing secret of the webhook destinations (one per automation), encrypted with AOM_SECRET_KEY. Never sent to the browser. */
  secretEnc: z.string().max(500).optional(),
});
```

- Add `deliverOutput: DeliverOutputSchema.optional()` to the `create_card` member of `ScheduleActionSchema` only.
  Absent means today's behaviour.
- `ScheduleDeliverySchema` gains:
  - an optional `secret: z.literal('output').optional()` on the `webhook` member, so `postWebhook` signs with
    `deliverOutput.secretEnc`;
  - a new member that holds **no message text**:

    ```ts
    z.object({ kind: z.literal('runner'), channel: z.enum(['whatsapp', 'google_sheet']), destination: z.number().int().min(0).max(4), cardId: Id, workstationId: Id })
    ```

- `ScheduleRunResultSchema` gains `outputCardId: Id.optional()`. Do **not** reuse `cardIds`: the `create_card` rate
  limit and dedupe queries count runs whose `cardIds` is not empty.

`protocol/runner.ts`: a new durable command `delivery.send` in `RunnerCommandName` and `CommandPayloadSchemas`.

```ts
DeliverySendPayloadSchema = z.object({
  runId: Id, attempt: z.number().int().positive(), test: z.boolean().default(false),
  channel: z.enum(['whatsapp', 'google_sheet']), instance: z.string().max(200),
  whatsapp: z.object({ to: z.array(z.string()), template: ...optional(), text: z.string().max(1200) }).optional(),
  sheet: z.object({ spreadsheetId: z.string(), sheet: z.string(), row: z.array(z.string().max(50_000)).length(5) }).optional(),
});
DeliverySendResultSchema = z.object({ ok: z.boolean(), httpStatus: z.number().int().optional(), error: z.string().max(500).optional(), retryable: z.boolean() });
```

`integrations/schema.ts` and `registry.ts`: add the kinds `whatsapp` and `google-sheets` to `INTEGRATION_KIND_IDS`,
group `other`, `instances: { by: 'account', ... }`, `flow: 'fields'`, with `minRunner` set to the runner version that
ships this card.

- `whatsapp`, method `token`, fields:
  - `phoneNumberId` (text, required; it becomes the instance);
  - `accessToken` (secret).

  Steps link to Meta's Cloud API "get started" page. Test: `GET /<phoneNumberId>?fields=display_phone_number,verified_name`.
  The status `account` is the display number.
- `google-sheets`, method `service_account`, field `keyJson` (secret, maxLength 8000). Test: a token exchange. The
  status `account` is `client_email`, which is not secret: the page shows it so the user can share the sheet with it.
  Steps: create a service account, create a JSON key, share the sheet with the account's e-mail as Editor.

`storage` text for both: "secrets/<kind>.json, encrypted (AES-256-GCM) with this runner's key, this workstation only".

### 4.2 Server

**`schedule-output.ts` (new)**

- `cardOutput(db, cardId)` returns `{ ref, title, text, source: 'handoff' | 'report', link }`.
  - `text` is the summary of the card's latest `InvestigationReported` when the card is investigation-only. Otherwise
    it is the body of the latest `thread_messages` row with `kind='handoff'` and `author_kind='agent'` (not
    `kind='review'`).
  - Empty text becomes "(no text: see the card)".
  - `link` is `${publicOrigin}` plus the card route the web app uses. Check the router and add one small helper.
- Per-channel formatters (pure, unit-tested):
  - `outputEmail(o, s, dest)`: subject = `dest.subject` expanded, or `"<automation>: <ref> <title>"`; text = output
    (cut at 20,000 characters) + "\n\n" + link.
  - `outputWebhookBody(format, o, s, at, test)`: `generic` is
    `{ event: 'schedule.output', schedule: {id, name}, trigger: 'event', at, text, data: { card: {ref, title, url}, output: {source} } }`;
    `slack` and `teams` reuse `webhookBody` with `text = "<ref> <title>\n<excerpt 3000>\n<link>"`.
  - `whatsappText(o)`: flattened, at most 500 characters + " " + link (see 3.2).
  - `sheetRow(at, s, o)`: `[ISO timestamp UTC, automation name, ref, title, text (cut at 45,000) + "\n\n" + link]`.
    These are the five agreed columns. The output text and the link share the fifth column because the card lists
    "output text/link" as one column.
- `queueOutputDeliveries(ctx, e, ec)` is called from `schedule-triggers.ts` `handleEvent` when `ec.name === 'card_done'`
  and `ec.card?.scheduleId` is set.
  - It loads the schedule. Nothing happens when the schedule is gone or disabled, its action has no `deliverOutput`,
    the org is not operational, or `assertOwnerStillAllowed` fails.
  - It appends one `ScheduleRunRecorded` per destination in one transaction. Each has:
    - `trigger: 'event'`, `sourceKey: output:<cardId>:<index>` (the unique index makes a replay a no-op);
    - `label: "Result of <ref> to <target>"`, `status: 'pending'`, `result: { outputCardId }`;
    - for email and webhook, a `delivery` with the composed text (as digests do today);
    - for WhatsApp and Sheets, the text-free `runner` delivery.
  - Then `attemptDelivery` runs for each run, after the commit.
  - The `card_done` loop guard (a schedule never answers its own card) applies to event-triggered schedules and does
    not touch this path.
- `sweepEventTriggers`: the "are there event schedules at all" gate must also be true when
  `action->'deliverOutput' IS NOT NULL` on an enabled schedule. Otherwise the done events are skipped.

**`schedule-delivery.ts`**

- `webhookSecret` gains a mode for `delivery.secret === 'output'`, which reads
  `action.deliverOutput.secretEnc`. `postWebhook` is otherwise **unchanged**, so the SSRF checks and the signature are
  the same code for digests and outputs.
- Factor the "record one try" block of `attemptDelivery` into `recordAttempt(ctx, run, s, attempt, result, {single})`.
  `attemptDelivery` and the runner answer both use it.
- `attemptDelivery`, for `delivery.kind === 'runner'`:
  1. If a `delivery.send` command for this run is still open (pending or sent) and the dispatch deadline has passed,
     mark it failed, empty its payload, and record a failed, retryable try with "the workstation <name> did not
     answer (offline?)".
  2. Otherwise check that the workstation is active and owned by the schedule owner. If not, record a final failure.
  3. Build the payload from `cardOutput(...)` and the destination, then `enqueueRunnerCommand(..., 'delivery.send', payload, expiresAt = now + 15 min)`.
  4. Set `next_attempt_at = now + 15 min` (the dispatch deadline) through a new event
     `ScheduleDeliveryDispatched { runId, scheduleId, attempt, commandId, deadline }`. Its projector only updates
     `next_attempt_at`, so `deliverDue` does not pick the run again while the runner works.
  5. Call `gateway.deliverPending(workstationId)` and return `null` (the outcome comes later).
- The message text exists only in the `runner_commands` payload. It is emptied (`payload = '{}'`) when the answer
  arrives and when the command expires. It is never put in an event, `schedule_runs` or a log line.

**`runner-gateway/handlers.ts`** `applyCommandResult`: a `delivery.send` branch.

- It calls `completeCommand`, empties the payload, parses `DeliverySendResultSchema` (an unparsable answer is
  "the workstation answered something unexpected", retryable), then
  `recordAttempt(run, attempt=payload.attempt, result, { single: payload.test })`.
- Ignore an answer whose run is no longer pending or whose attempt does not match (the existing `FOR UPDATE` check).
- The command must be terminal on both sides: no blind re-send of the command. Retries come only from the schedule
  backoff.

**`schedules.ts`**

- `validate`, `create_card` with `deliverOutput`, per destination:
  - email: `isEmailAddress`, plus the same "members mail only themselves" rule as digests;
  - webhook: `assertWebhookUrl`;
  - whatsapp and google_sheet: the workstation is active and belongs to the **schedule owner** (as
    `actionWorkstationId` requires for polls), and the integration status the runner reported for (kind, instance) is
    `connected`. Otherwise: "connect WhatsApp on the Integrations page of <workstation> first". The runner's version
    must also be at least the registry's `minRunner`.
- `createSchedule`: when any webhook destination exists, `newSecret()` → `deliverOutput.secretEnc`, returned once as
  `webhookSecret`, as today.
- `patchSchedule`: carry over `deliverOutput.secretEnc` the way the webhook `secretEnc` is kept. Create a secret when
  a webhook destination is added and none exists.
- `rotateWebhookSecret`: also accept a `create_card` schedule with a webhook destination.
- `publicAction` strips `deliverOutput.secretEnc`. `hasWebhookSecret` is also true for it.
- `testSchedule`: also accept `create_card` with `deliverOutput`.
  - The sample is the output of the newest done card of this schedule, if there is one. Otherwise a fixed sample:
    "Test delivery from the automation "<name>". The agent's result appears here."
  - It makes one test run per destination (`trigger 'test'`, `single`).
  - For runner destinations it waits up to 20 s for the run to leave `pending`, then answers `pending: true` ("sent to
    the workstation; the result appears in the history").
  - The response keeps today's fields (`ok` = all ok; the others are those of the first destination) and adds
    `results: [{ index, kind, target, ok, pending?, httpStatus, error, durationMs, runId }]`.
  - A WhatsApp test with a template uses that template. Meta's `hello_world` works as the template on a test number.
- `listRuns`: widen `delivery.kind` to `'webhook' | 'email' | 'whatsapp' | 'google_sheet'` (for runner deliveries, the
  channel). The target is: the numbers for WhatsApp, `Sheet <first 8 characters of the id>… / <tab>` for Sheets.
  `ScheduleRunDto` type is widened additively.

**Logs**

- Never log `payload` of `delivery.send`, the delivery `text` or `body`, or any envelope.
- Add `*.whatsapp.text` and `*.sheet.row` to the pino `redact` paths as a second line of defence.

### 4.3 Runner (`apps/runner`)

- `secrets/sealed-file.ts`: the encrypted store (3.4).
- `integrations/whatsapp.ts` and `integrations/google-sheets.ts`: `IntegrationAdapter`s (`instances`, `status`,
  `connect`, `test`, `remove`).
  - `connect` saves only after the provider accepted the credential.
  - The Sheets adapter checks `type === 'service_account'` and the presence of `client_email` and `private_key`.
  - Register both in `IntegrationService`.
- `outbound-delivery/` (new): `send.ts` dispatches `delivery.send`; `whatsapp.ts` and `google-sheets.ts` do the HTTP
  calls (10 s timeout, `redirect: 'manual'`). Classification:
  - 2xx is ok;
  - 408, 429 and 5xx (`isRetryableStatus`) and network errors are retryable;
  - other 4xx is final;
  - no credential for the instance is final ("WhatsApp is not connected on this workstation");
  - an expired or revoked token (401, or Graph error code 190) is final, with the reason
    "reconnect on the Integrations page".

  Errors carry the provider's code and short message only, cut at 300 characters. **Never the message text, the
  access token or the key.** The Sheets access token is cached in memory until 60 s before its expiry.
- `runner.ts`: the `delivery.send` branch answers `done(true, result)`. A thrown error is answered as
  `{ ok: false, retryable: true }`.
- Local log: channel, run id, status and duration only.

### 4.4 Web (`apps/web`)

- `components/schedules/ScheduleWizard.tsx`, the "Create a card" action: a new section "Send the result when the card
  is done", switched off by default.
  - A list of destinations (at most 5), each with a kind picker (Email, Webhook, WhatsApp, Google Sheet) and a remove
    button.
  - Email: To (`type=email`, `inputMode=email`), Subject.
  - Webhook: URL (`inputMode=url`), Format. The signing secret is shown once after saving, as today.
  - WhatsApp: the workstation and connected-number picker (from the owner's workstations' integration statuses), To
    numbers (`type=tel`, `inputMode=tel`, `autoComplete=tel`, E.164 hint), and template name and language
    (optional). The hint explains the 24-hour rule.
  - Google Sheet: workstation and service-account picker, then the sheet URL or ID. The ID is extracted from a pasted
    URL with `/spreadsheets/d/([A-Za-z0-9_-]+)/`. Then the tab name. Show the service account e-mail with a copy
    button and "share the sheet with this address as Editor".
  - When no WhatsApp or Sheets connection exists, link to the Integrations page of the user's workstation. **No secret
    is typed in the wizard.**
- Touch and small screens: the destination rows stack in one column below `sm`. Every input sits in normal document
  flow (no fixed footers over it), so the soft keyboard can scroll it into view. Tap targets are at least 44 px.
- "Send test" (the existing `useTestSchedule` in `api/queries/schedules.ts`): a "Send a test" button on the automation
  for `create_card` schedules with `deliverOutput`. It shows one line per destination: ok, failed with the reason, or
  "sent to the workstation; see the history".
- `RunHistory.tsx`: labels for the new delivery kinds. A failed run already shows the error and the try log, so
  AC4 needs no new UI beyond the labels.
- The Integrations page renders the two new kinds from the registry without page-specific code (that is how the
  registry works). Check that the field types render and that the secret input is cleared after sealing.

### 4.5 Modes

There is no gate on the organization mode: the section shows in every mode. A schedule without `deliverOutput`
follows exactly the same code path as today.

## 5. Acceptance criteria → design

| AC | Covered by | Tests the builder writes |
|---|---|---|
| 1. Output by email, webhook, WhatsApp and Google Sheet; each works with "send test" against a test destination | `deliverOutput`, `queueOutputDeliveries`, the per-channel formatters, runner `delivery.send`, and `testSchedule` per destination. | Shared unit: formatters (flattening, cut, link, the five row columns, RAW), schema validation. Server: `attemptDelivery` per kind with mocked `fetch`/mailer (ok, retryable, final); runner kind enqueues `delivery.send` and applies the answer; `card_done` of a scheduled card creates N runs once (replay is a no-op); `testSchedule` returns `results[]`. Runner unit: WhatsApp and Sheets senders with mocked `fetch` (template vs text, 131047 final, 429 retryable, JWT claims). Web: the wizard adds destinations and calls the test hook. E2E (tester): an automation whose card output arrives at a local test webhook, extending `e2e/tests/schedules.spec.ts`. Live WhatsApp and Sheets "send test" against Meta's test number and a test sheet is a manual QA step: it needs real accounts. |
| 2. Webhook output is signed and SSRF-checked; private addresses are refused | The same `postWebhook`, with the secret taken from `deliverOutput.secretEnc`; `validate` runs `assertWebhookUrl` per destination. | Server: an output webhook carries a valid `x-guildwise-signature`; `http://127.0.0.1`, `10.x` and a host that resolves to a private address are refused (400 at create, final failure at delivery). |
| 3. WhatsApp and Sheets credentials stored encrypted, never shown in full or logged | Sealed envelope from the browser; `sealed-file.ts` at rest on the runner; registered with `redact.ts`; the server stores none; no secret in wizard, DTO or logs. | Runner: the file on disk is not plaintext and decrypts back; the adapter status holds no token; error texts hold no token (assert on a token-shaped string). Server: the DTO has no `secretEnc`; `delivery.send` payload emptied after the answer; a log-capture test shows no message text. |
| 4. A failed delivery is retried with backoff, then shown failed with the reason | Shared `recordAttempt` (`WEBHOOK_MAX_ATTEMPTS`, `webhookBackoffMs`); the dispatch deadline turns an offline runner into a retryable failure. | Server: five failed tries → status `failed` with the last error; offline runner → "did not answer" then retry; `listRuns` shows the reason. |
| 5. Existing digest schedules keep working unchanged | Only optional fields and union members are added; the `webhook` and `email` delivery paths are unchanged when `secret` is absent. | Run the existing `schedules*.test.ts` and digest tests unchanged, plus one regression test that a digest webhook still signs with the action secret. |

## 6. Risks

- **The runner is offline at send time.** The result is delayed and then fails with a clear reason after about
  2.5 hours of tries. This is accepted, because the runner must hold the credential (owner decision).
- **WhatsApp template rules** (the 24-hour window, variable limits) cause most failures. Show the reason clearly, link
  to Meta's template manager, and keep the limits in constants.
- **The agent output may contain internal text** (agent names, review history). The owner chooses the destinations.
  The outbound internal-text filter (`OutboundBlocked`) is not applied in this card: backlog follow-up.
- **Overlap with GWP-37:** it must reuse `sealed-file.ts` and the `whatsapp` integration kind, not make a second
  store. GWP-32 comes first in the business-workflows group and introduces them. GWP-37 adds its inbound fields.
- **Integration kind ids are new enum values.** Old runners do not know them. The server refuses destinations on a
  runner older than `minRunner`, and the Integrations page shows its usual "update your runner" banner.
- **The card scope said apps/server, apps/web, packages/shared and e2e.** Owner decisions 3 and 5 move WhatsApp and
  Sheets sending into `apps/runner` (same repository), so the builder also works there.
- **The owner's research file** (role and playbook text) is not needed for this card: no role, rule or playbook text
  is written. The vault path given on the thread was not present in this workstation's vault clone at design time.

## 7. Out of scope (follow-ups)

- Output delivery for `ba_task` (CEO brief) automations. GWP-34 can reuse `OutputDestinationSchema`.
- Sending from the user's own mail account (would be runner-side too).
- Moving `jira.json` and `git-tokens.json` onto the encrypted store.
- Applying the outbound internal-text filter to output deliveries.
