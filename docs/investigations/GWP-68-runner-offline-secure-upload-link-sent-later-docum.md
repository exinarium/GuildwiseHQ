# Runner offline during a public form submission: secure link sent later (design)

Release 1.5.0, repository GuildwiseHQ. Builds on GWP-65 (public form hosting) and GWP-67 (journey waits), both merged
into the working branch. GWP-63 (storage connectors), GWP-64 (forms builder) and GWP-66 (journeys model) sit underneath
them.

**Revision 2026-11-04 (assumption review).** The design was first written before GWP-65 and GWP-67 landed. Section 9
lists every assumption and what the landed code showed. Assumptions 1, 3, 4 and 5 did not hold as written, and the
sections they touch (4.3, 4.4, 4.5, 4.6, 4.8, 6) are revised. The manager answered the option A question: **A2** (ledger
`fbe4e064-5c30-446a-8779-87ae8d11128d`, 2026-11-03). Section 3 now states A2 as the mechanism to build.

## 1. The question

A client opens a public form (public URL, QR code or personal link) while the firm's runner is offline. Answers and
uploads can only reach the firm's storage through that runner (GWP-63), and the server keeps none of them (owner decision
5). Owner decision 6 sets the rules:

1. The page tells the client that a secure link will be emailed. It does **not** accept the answers or files (option B).
2. If the form belongs to a journey, the instance shows a visible wait, "documents pending, runner offline".
3. When the runner comes back, the links go out **automatically**, one per case, even if the runner drops and returns
   again (flapping).
4. The desk gets one notification per case: who, when (attempt time, link sent time), which journey and form.
5. The journey continues by itself when the submission lands. The desk also has a "Continue journey" action.
6. The secure link is per client, signed, expiring (configurable) and single use.
7. How the contact details and the request are held while the runner is offline is "option A". This design states it
   (section 3). The manager confirmed A2.

## 2. Findings in the code (checked against the landed GWP-65 and GWP-67 code)

| Where | What is there | Use for this card |
|---|---|---|
| `apps/server/src/public-forms/routes.ts` `onRequest` | Shared by every public route. Resolves the published form (`pubs` WeakMap) and takes the IP and start rate limits. Runs before the body is parsed | **Add the runner check here for `op === 'start'`** (section 4.3) |
| `routes.ts` start handler, lines ~566-588 | The presence check runs **in the handler, after** the body is parsed and the session, honeypot, PoW, link and answers are checked. It looks at the answers destination and the file fields that have a file in the manifest, maps them with `connectionsOf` (`storage_connections.workstation_id`) and calls `ctx.services.runners.isOnline(ws)`. If offline it calls `offline(...)` | Stays as a second check (a runner can drop between `onRequest` and the handler) |
| `routes.ts` `offline(...)` + `public-forms/offline-hook.ts` | `RunnerOfflineHook` in `ctx.services.publicFormsOffline`; the default answers `unavailable`, which becomes `503 runner_offline` (retryable). `link_later` replies `202 { status: 'link_later', message }`. Also called from the part and complete stages | **Keep the default hook** (503 `runner_offline`). The web switches to the offline panel on that code. `link_later` is not used, because it ends the page without asking for an email |
| `routes.ts` `checkLink` | 410 `link_expired`, `link_revoked`, `link_used`, 404 `link_invalid` with "personal link" sentences | Reused for the secure link. The definition reply gets `link.purpose` so the page can use secure-link sentences |
| `public-forms/tokens.ts` | `signClientLink`/`verifyClientLink` (`v1.<linkId>.<exp>.<sig>`, key `signingKey(ctx,'form-client-link')`), `verifySession`, `powValid`, `signSession` exported | The secure link is a GWP-65 client link. The session checks are reused (the call sequence is inline in the start handler, section 4.3) |
| `public-forms/limits.ts` | `KeyedBuckets` class (exported), `FormLimits { ip, ipSubmit, formSubmit }`, `createFormLimits`, `clientKey` | Add `offlineIp` and `offlineForm` buckets to `FormLimits` |
| `migrations/2830_public_forms.sql` | `form_client_links` (id text, reference NOT NULL, record_kind/record_id, expires_at, created_by uuid NOT NULL, revoked_at, used_at, used_by_submission); `form_submissions.session_nonce` UNIQUE is the only single-use session guard | No single-use helper exists: the offline table gets its own `session_nonce UNIQUE` (section 4.1) |
| `commands/public-forms.ts` `createClientLinkIn(tx, ctx, { orgId, formId, by, reference, recordKind?, recordId?, expiresAt })`, `revokeClientLinkIn`, `clientLinkUrl` | In-transaction create (form must be published), revoke, and the URL signed on read | Add optional `purpose` and `offlineRequestId`. `by` must be a user id: the journey's `started_by`, or `form_publications.published_by` for a public-URL case |
| `packages/shared/src/events/form.ts` `FormClientLinkCreated` | `by: Id` required | Add `purpose?: 'offline'`, `offlineRequestId?: Id` (optional, old events replay unchanged) |
| `migrations/2840_journey_waits.sql` `journey_waits` | **`UNIQUE (instance_id, visit)`**: one wait per step visit; kinds `duration, date, form, webhook, gate, manual`; `link_id`, `events jsonb` timeline | The offline wait cannot be a second wait row. It is a **sub-state of the form wait** (section 4.6) |
| `journeys/waits.ts` | `enterWaitStep` (form wait creates a client link with the record reference), `resolveFormWait(ctx, waitId)` (only when **the wait's own `link_id`** is used), `continueWait(ctx, waitId, by)` (guarded: wait `FOR UPDATE`, `lockInstance`, refuses gates), `resendLink`, `refreshLink` (revokes the old link, makes a new one), `resolveAndAdvance` exported | The secure link becomes the wait's link (`JourneyWaitLinkSent`), so the existing tick resumes the journey. The desk continue uses `continueWait` |
| `journeys/tick.ts` `journeyTick` | Resolves form waits whose `link_id` row has `used_by_submission` | Nothing to add once the wait points at the secure link |
| `journeys/wait-effects.ts` `endWaitSideEffects` | When a wait ends: revokes the wait's unused link, closes every open desk item with `data->>'waitId'` = the wait | The offline desk item carries `waitId`, so it closes with the wait. A manual continue revokes the unused secure link |
| `projections/journey-waits.ts` `JourneyWaitLinkSent` | Sets `link_id`, `link_expires_at`, `desk_item_id`; timeline note by `via` | New `via: 'offline_email'` and its note |
| `commands/journey-waits.ts` `listInstanceWaits` / `WaitDto`, `routes/journey-waits.ts` `POST /api/journey-waits/:waitId/continue` | Instance waits with timeline; continue route with `mayManage` (project owner, Owner/Admin, the addressee of the wait's desk item) | `WaitDto.offline` added; the instance Continue button already exists |
| `apps/web/src/components/journeys/InstanceWaitPanel.tsx`, `components/JourneyDeskItem.tsx` | Wait card with badges and timeline; desk buttons that call the wait routes by `data.waitId` | Offline badge on the wait card; `FormOfflineLinkBlock` calls the same wait route |
| `apps/server/src/queries/desk.ts` `toDeskDto` | Passes `data` to the web **only for whitelisted keys** (`JOURNEY_DESK_SUBKINDS`, `JOURNEY_DATA_KEYS`) | Add the two new subkinds and their keys, or the block gets no data |
| `apps/web/src/public-form/PublicFormPage.tsx`, `messages.ts` | Phases `loading, closed, form, later`; `runner_offline` reads "try again later, your answers are still here" | New offline phases and sentences (section 4.7) |
| `projections/workstations.ts` | `WorkstationConnected` sets `connected = true` (active workstations), `WorkstationDisconnected` false | SQL presence for the sweep; add `connected_at` |
| `runner-gateway/handlers.ts` `reconcile(conn)` | Runs once per connection after the outbox flush | Reconnect hook: `ctx.services.formsOffline?.onReconnect(conn.workstationId)` |
| `scheduler/scheduler.ts` `triggers()` | `sweepSubworkflows`, `sweepJourneys`, `sweepEventTriggers`, `sweepIntegrations`, each with `.catch` | Add `sweepFormsOffline` after `sweepIntegrations` |
| `auth/secrets.ts` | `encryptSecret`/`decryptSecret`, `signValue`, `signingKey(ctx, purpose)` | Add `encryptFor/decryptFor` (section 3.2) |
| `projections/rebuild.ts` `SAVED` | Operational tables kept over a rebuild | Add `form_offline_requests` |
| `CHANGELOG.md` | `## [1.5.0]` heading already exists | Add the entry under it |

## 3. Option A: how the contact details and the request are held while the runner is offline

### 3.1 Options compared

| | A1. Server holds **only the email address**, encrypted, until the link is sent | **A2. As A1, but the email is kept until the case closes (chosen)** | A3. Email the link at once, hold nothing | A4. Hold the answers too and replay them |
|---|---|---|---|---|
| Answers or documents on Guildwise servers | none | none | none | **yes: breaks decision 5** |
| Personal data held | one email, encrypted, hours to days | one email, encrypted, until the link is used, expires or the case is closed (at most hold days + link days) | none | answers and email |
| Links sent automatically when the runner returns | yes | yes | no | yes |
| Desk can see who, and resend | client reference only | can show the email (audited) and resend the link | no | yes |

A3 does not meet decision 6 and A4 breaks decision 5. **The manager chose A2** (ledger `fbe4e064`, answer of
2026-11-03: "A2: as A1, but the encrypted email is kept until the case closes so the desk can view it and resend the
link"). The CEO ruling for GWP-67 (ledger `8a9b947f`) said no contact email on the journey record and left this mechanism
to GWP-68. A2 holds the email in its own operational table, never on the journey record, which fits that ruling.

### 3.2 The mechanism (A2), as it should be written in the spec

- **What is held.** One row per case in `form_offline_requests` (section 4.1): the email address the client typed on
  the offline panel (encrypted), the form id and version, the client link id when the client came through a personal
  link, the journey instance, visit and wait id when that link belongs to a form wait, the timestamps and a status.
  **Nothing else**: no answer, no file, no name, no phone number, no IP address, no user agent. The browser never sends
  the answers to the offline endpoint (section 4.3).
- **Where.** The Guildwise HQ server's database, in an operational table that is **not event-sourced**. The email never
  goes into the event log (events are immutable and replayed, so a ciphertext there could never be deleted) and never
  into logs, desk items, metrics or error reports. Events carry only the case id and timestamps.
- **Encrypted how.** AES-256-GCM, 96-bit random IV, with a key derived per purpose from the server secret:
  `HMAC-SHA256(key(ctx), 'enc|form-offline-contact')`, where `key(ctx)` is the existing `secrets.ts` key
  (`AOM_SECRET_KEY`, or the generated DB key when unset). The case id is the GCM additional authenticated data, so a
  ciphertext copied to another row does not decrypt. Format `v1:<iv>:<tag>:<ct>` (same as `encryptSecret`). A separate
  keyed hash `email_key = HMAC-SHA256(signingKey(ctx,'form-offline-email'), lower(trim(email)))` is kept only to refuse a
  second open case for the same email on the same form. It is cleared with the email.
- **For how long.** Until the case closes:
  - `submitted`: the secure link was used (submission stored in the firm's storage);
  - `continued`: the desk continued the journey, or the form wait ended in any other way;
  - `expired`: the runner did not come back within the **hold period** (`AOM_FORMS_OFFLINE_HOLD_DAYS`, default 7,
    range 1 to 30), or the secure link expired unused (link days, default 7, range 1 to 30);
  - `failed`: sending failed for good, or the key was rotated;
  - `cancelled`: the desk cancelled the case, the form was unpublished, or the wait's link was replaced.
  The longest possible hold is hold days + link days (default 14 days, at most 60).
- **When it is deleted.** `email_enc` and `email_key` are set to NULL in the same transaction that closes the case.
  After that the row holds only references and times. It is deleted 30 days after the case closes. With PostgreSQL the
  old tuple is gone after vacuum; backups follow the operator's backup retention (stated in `docs/SELF-HOSTING.md`).
- **Desk access (A2).** While the case is open, an Owner or Admin can **Show email** (decrypted on request, never stored
  in the desk item, audited with `FormOfflineEmailViewed { requestId, formId, by }`, no email in the event) and
  **Resend link** (the same link, only while it is unused and unexpired, at most 3 times, audited with
  `FormOfflineLinkResent { requestId, formId, by, n }`).
- **Rotating `AOM_SECRET_KEY`** makes held emails unreadable: those cases become `failed` with a desk notice, as with
  client links in GWP-65 (documented).

### 3.3 What the client sees and receives

- Offline panel (section 4.7): "<Firm> can't receive forms right now. Enter your email address and we'll send you a
  secure link as soon as they are back online. You'll need to fill in the form again with that link." One email field
  and a **Send me the link** button. After sending: "Thanks. We'll email you a secure link when <Firm> is back online."
  The same answer comes back for a duplicate, so nobody learns from it whether an email address already has a case.
- One email when the runner returns, holding only the firm name and the link (section 4.5), and the same email again
  only when the desk presses Resend. No confirmation email at once.

## 4. Design

### 4.1 Data model (migration `apps/server/migrations/2850_forms_offline.sql`, next free number at build time)

```sql
-- Operational, not event-sourced (the email must be deletable). Kept over a projection rebuild (SAVED in rebuild.ts).
CREATE TABLE IF NOT EXISTS form_offline_requests (
  id uuid PRIMARY KEY,                         -- uuidv7: the case id
  org_id uuid NOT NULL REFERENCES organizations(id),
  form_id uuid NOT NULL, form_version int NOT NULL,
  session_nonce text NOT NULL UNIQUE,          -- the GWP-65 form session is single use (no shared helper exists)
  origin_link_id text,                         -- form_client_links.id the client came through (NULL = public URL)
  journey_instance_id uuid, journey_visit int, journey_wait_id uuid, -- when the origin link is an open form wait's link
  record_kind text, record_id text,            -- copied from the origin link (references only)
  workstation_ids uuid[] NOT NULL,             -- the destination workstations it waits for (recomputed before send)
  email_enc text,                              -- AES-256-GCM, AAD = id; NULL once the case is closed (section 3.2)
  email_key text,                              -- keyed hash, dedupe only; NULL with email_enc
  status text NOT NULL CHECK (status IN ('held','sending','sent','submitted','continued','expired','failed','cancelled')),
  attempts int NOT NULL DEFAULT 0,             -- mail attempts
  next_attempt_at timestamptz,
  resends int NOT NULL DEFAULT 0,              -- desk resends (A2), at most 3
  error_code text,                             -- mail_failed | key_unreadable | form_unpublished | link_replaced | ...
  attempted_at timestamptz NOT NULL,           -- the offline submission attempt (shown on the desk and the wait)
  hold_expires_at timestamptz NOT NULL,
  link_id text,                                -- the secure link (a form_client_links row, purpose 'offline')
  link_expires_at timestamptz, link_sent_at timestamptz,
  submission_id uuid, submitted_at timestamptz,
  desk_item_id uuid,
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, closed_at timestamptz
);
CREATE INDEX IF NOT EXISTS form_offline_requests_open ON form_offline_requests (status, next_attempt_at)
  WHERE status IN ('held','sending','sent');
CREATE INDEX IF NOT EXISTS form_offline_requests_wait ON form_offline_requests (journey_wait_id)
  WHERE journey_wait_id IS NOT NULL;
-- one open case per personal link, and per email on a form
CREATE UNIQUE INDEX IF NOT EXISTS form_offline_requests_link ON form_offline_requests (form_id, origin_link_id)
  WHERE origin_link_id IS NOT NULL AND status IN ('held','sending','sent');
CREATE UNIQUE INDEX IF NOT EXISTS form_offline_requests_email ON form_offline_requests (form_id, email_key)
  WHERE email_key IS NOT NULL AND status IN ('held','sending','sent');

ALTER TABLE workstations ADD COLUMN IF NOT EXISTS connected_at timestamptz;          -- set by WorkstationConnected
ALTER TABLE form_client_links ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'client'; -- client | offline
ALTER TABLE form_client_links ADD COLUMN IF NOT EXISTS offline_request_id uuid;
```

- `projections/workstations.ts`: `WorkstationConnected` also sets `connected_at = e.createdAt` (rebuild-safe).
- `FormClientLinkCreated` (shared `events/form.ts`) gets `purpose?: 'offline'` and `offlineRequestId?: Id`;
  `projections/public-forms.ts` writes them. `createClientLinkIn` takes the two optional fields.
- `JourneyWaitLinkSent.via` (shared `events/journey-waits.ts`) gets a third value `'offline_email'`.

Events (`packages/shared/src/events/forms-offline.ts`, stream `form-<formId>`, registered in the events index), all
**without** an email or any answer:

- `FormOfflineRequested { requestId, formId, orgId, linkId?, journeyInstanceId?, waitId?, attemptedAt }`
- `FormOfflineLinkSent { requestId, formId, linkId, sentAt, expiresAt }`
- `FormOfflineLinkResent { requestId, formId, by, n }` (A2)
- `FormOfflineEmailViewed { requestId, formId, by }` (A2)
- `FormOfflineClosed { requestId, formId, result: 'submitted'|'continued'|'expired'|'failed'|'cancelled', submissionId?, by? }`

And one on the journey instance stream (shared `events/journey-waits.ts`): `JourneyWaitOfflinePending { waitId,
requestId, attemptedAt }`. Its projector adds only a timeline note "Documents pending, runner offline" to the wait row.

The operational row is the source of truth for sending; the events are the audit trail.

### 4.2 Shared (`packages/shared/src/forms/offline.ts`, exported)

```ts
export const OfflineRequestSchema = z.object({
  session: z.string(), nonce: z.string(), website: z.string().max(0),   // GWP-65 session, PoW, honeypot
  email: z.email().max(254),
  link: z.string().regex(CLIENT_LINK_TOKEN_RE).optional(),
}).strict();
export const OFFLINE_WAIT_KIND = 'documents_pending_runner_offline'; // a sub-state name, not a journey_waits.kind
export const OFFLINE_WAIT_LABEL = 'Documents pending, runner offline';
export const OFFLINE_LINK_DAYS = { default: 7, min: 1, max: 30 } as const;
/** Pure: the desk notification text from the case (tested). Never takes an email. */
export function offlineNoticeText(c: OfflineNoticeInput): { title: string; body: string };
```

`PublicFormDto` (shared `forms/public.ts`): add `availability: 'open' | 'offline'`, and `link` becomes
`{ state: 'valid'; expiresAt: string; purpose: 'client' | 'offline' } | null`.

Form setting (GWP-64 `FormSettings`, optional): `offlineLinkDays?: number` (1 to 30). Shown in `FormSettingsPanel.tsx`
as "Secure link expiry when your runner is offline: [7] days". Fallback: form setting → `AOM_FORMS_OFFLINE_LINK_DAYS`
→ 7.

### 4.3 Offline at the public page (server: `apps/server/src/public-forms/offline.ts`, routes in `routes.ts`)

**Detect early, before any answer is sent:**

1. `GET /api/public/forms/:publicId` adds `availability`. A helper `destinationsOnline(pub, def)` in `routes.ts` takes the
   answers destination and **every** file field's destination of the published version, maps them with `connectionsOf`
   and checks `ctx.services.runners.isOnline(ws)`. Any offline → `'offline'`. The page then shows the offline panel
   **instead of the form fields**. A missing destination stays GWP-65's `destination_missing`, not offline.
2. `POST …/submissions` (start): **add** the same check to the shared `onRequest` for `op === 'start'`, after the
   publication lookup and rate limits (`pubs.get(req)` is set, `definitionOf` is in scope). If offline, throw
   `PfError(503, 'runner_offline', OFFLINE_MSG, { retryable: true }, { close: true, retryAfter })`. Fastify parses the
   body only after `onRequest`, so the answers in that body are never parsed. **The existing check in the handler stays**
   (it covers a runner that drops between the two). Note the `onRequest` check is wider than the handler's: it also
   counts file fields the client left empty, the same rule as `availability`.
3. `PUT …/parts/:i` and `POST …/complete` already go through `offline(...)` with the default hook (503
   `runner_offline`). No server change. The web treats them like the start reply. Parts already stored stay in the firm's
   storage as GWP-65 does today.
4. The `RunnerOfflineHook` is left as the default. This card does not use `link_later`.

**The offline request:** `POST /api/public/forms/:publicId/offline-requests`, registered inside the same plugin
(`config: { op: 'offline' }`, add `'offline'` to `PfCall['op']`), `logLevel: 'silent'`, the shared `onRequest` and error
handler, no echo, no cookie. Handler in `public-forms/offline.ts`, given the plugin's helpers (`pubOf`, `checkLink`,
`definitionOf`, `destinationsOnline`, `limits`).

1. Rate limits: new `FormLimits` buckets `offlineIp` (`clientKey`, 3 per hour, burst 2) and `offlineForm` (30 per hour),
   plus at most 500 open cases per org (SQL count) (`AOM_FORMS_OFFLINE_IP_PER_HOUR`, `AOM_FORMS_OFFLINE_FORM_PER_HOUR`,
   `AOM_FORMS_OFFLINE_MAX_OPEN`, in `config.publicForms`).
2. Session, minimum fill time, honeypot and PoW: the same sequence as the start handler (`verifySession`, TTL,
   `session.version === pub.version`, `cfg.minFillMs`, `website === ''`, `powValid`). Extract it into one local function
   in `routes.ts` used by both routes, so the rules cannot drift. The session is single use through
   `form_offline_requests.session_nonce UNIQUE`.
3. Client link, if given: `checkLink(pub, token)`. Journey context: `SELECT id, instance_id, visit FROM journey_waits
   WHERE link_id=$1 AND kind='form' AND status IN ('open','escalated')` (index `journey_waits_link`). There is no
   `findFormWait` in GWP-67; this query replaces it.
4. Still offline? Re-check with `destinationsOnline`. If the runner is back: `409 { error: { code: 'runner_online' } }`
   and the page reloads the form.
5. In one transaction: insert the row (`held`, `email_enc`, `email_key`, `session_nonce`, `attempted_at = now`,
   `hold_expires_at = now + hold days`, `workstation_ids` = the offline destination workstations, the journey ids),
   append `FormOfflineRequested`, and when there is a wait, `JourneyWaitOfflinePending` on the instance stream. A
   unique-index conflict on link or email means a duplicate: roll back, change nothing. A conflict on `session_nonce` is
   GWP-65's `409 session_used`.
6. Always `202 { status: 'pending' }`, for a new case and a duplicate alike.

The email is never logged. The route is silent; `LOG_REDACT` gets `email` as a second guard.

### 4.4 Reconnect: send the links (`apps/server/src/commands/forms-offline.ts`, `sweepFormsOffline(ctx)`)

Called from `Scheduler.triggers()` after `sweepIntegrations` (with the same `.catch`). It runs on every tick and 750 ms
after new events (the `WorkstationConnected` append kicks it). `handlers.ts` `reconcile()` also calls
`ctx.services.formsOffline?.onReconnect(workstationId)`, which only schedules a sweep after the settle delay. No runner
change.

Each pass:

1. **Due to send**: rows `held` with `next_attempt_at IS NULL OR next_attempt_at <= now`, where every workstation of the
   form's *current* published destinations is `connected = true` and `connected_at <= now - settle`
   (`AOM_FORMS_OFFLINE_SETTLE_SEC`, default 30, 0 disables). The sweep reads SQL presence, not the in-memory registry.
2. **Claim**: `UPDATE … SET status='sending', updated_at=now WHERE id=$1 AND status='held' RETURNING *`. Rows in
   `sending` older than 5 minutes are reclaimed.
3. **Issue the link once**, in one append transaction, if `link_id` is NULL:
   - `createClientLinkIn(tx, ctx, { purpose: 'offline', offlineRequestId, reference: <origin link reference or
     'public'>, recordKind/recordId from the origin link, expiresAt = now + link days, by })`, with `by` = the
     instance's `started_by` for a journey case, else `form_publications.published_by`. Store `link_id` and
     `link_expires_at`.
   - **Journey case** (`journey_wait_id` set): lock the wait (`FOR UPDATE`) and `lockInstance(tx, instanceId, visit,
     'waiting')`. If the wait is still open, revoke the wait's **current** `link_id` (`revokeClientLinkIn`; it may be the
     origin link or a reminder's link) and append `JourneyWaitLinkSent { waitId, linkId: <secure>, via: 'offline_email',
     expiresAt }`. The wait now points at the secure link, so GWP-67's `journeyTick` resumes the journey when it is used.
     If the wait already ended, close the case (step 8b) instead of sending.
   - A reclaimed row reuses the stored link: a repeated send is the **same** link, never a second one.
4. Commit, then decrypt the email and send `formSecureLinkMail` (section 4.5). URL: `clientLinkUrl(ctx, orgId, formId,
   linkId)` (`${origin}/f/<publicId>#c=<token>`).
5. **Accepted** by the mail server → one transaction: `status='sent'`, `link_sent_at`, `FormOfflineLinkSent`, the desk
   notification (section 4.5). Under A2 the email is **kept** until the case closes.
6. **Mail failure** → `status='held'`, `attempts+1`, `next_attempt_at` with backoff (1, 5, 15, 60 min). After 5
   attempts: `failed`, email cleared, `FormOfflineClosed { result: 'failed' }`, desk notice "We could not email the
   secure link". Decryption failure (key rotated) → `failed` at once with `error_code='key_unreadable'`.
7. **Hold expired** (`held` past `hold_expires_at`): `expired`, email cleared, `FormOfflineClosed`, one desk notice per
   case (`form_offline_hold_expired`): "Your runner was offline for 7 days; we could not send the secure link and have
   deleted the email address."
8. **Closing open cases** (`sent`, and `held` for 8b):
   - a. The secure link is used (`form_client_links.used_by_submission IS NOT NULL`) → `submitted`, `submission_id`,
     `submitted_at`, email cleared, `FormOfflineClosed { result: 'submitted' }`. For a journey case the wait is resolved
     by GWP-67's tick (the wait's link). For a public-URL case the desk item is resolved `acknowledged` with note
     "Submission received".
   - b. Journey case whose wait has ended (`journey_waits.status` not open/escalated) → `continued` when the wait
     resolution is `continued` or `form_submitted` through another link, else `cancelled`; email cleared,
     `FormOfflineClosed`. The desk item was already closed by `endWaitSideEffects`.
   - c. Journey case whose wait now points at another link (the desk pressed GWP-67's "Resend link", which revokes ours)
     → `cancelled`, `error_code='link_replaced'`, email cleared.
9. **Link expired unused** (`sent` past `link_expires_at`): `expired`, email cleared, `FormOfflineClosed`, desk note
   "the secure link expired unused".
10. **Unpublished form** while open: `cancelled`, email cleared, desk notice.
11. Prune closed rows older than 30 days.

**Flapping:** offline → online → offline → online. The case leaves `held` exactly once (the claim), the link is created
once (step 3) and the desk item is raised in the `sent` transaction (step 5). Neither a second reconnect nor a second
process can send a second link or raise a second notification. If the runner drops before the settle delay ends,
nothing is sent yet. If the client opens the secure link while the runner is offline again, the definition reply has
`availability: 'offline'` and `link.purpose: 'offline'`; the page shows "<Firm> can't receive your form right now. Your
secure link stays valid until <date>; please try again later." and creates **no** new case.

### 4.5 The email and the desk notification

Email (`apps/server/src/mail/templates.ts`, `formSecureLinkMail({ to, firmName, link, expiresAt, origin, orgId })`,
using `brandedMail`): only the firm name, the link and its expiry. **No form title, no answer, no client reference.**

- Subject: `Your secure link from <Firm>`
- Heading: `<Firm> is ready for your form`
- Body: "<Firm> could not receive your form earlier. You can send it now with your secure link."
- CTA: `Open your secure link` → the link
- Note: "This link works once and expires on <date>. If you did not ask for it, you can ignore this email."

The firm name comes from `organizations.name`, passed through `oneLine` and escaped by the layout. The desk resend (A2)
sends the same template with the same link.

Desk notification (one per case, raised in the `sent` transaction):

- `DeskItemCreated`, `kind 'alert'`, `subkind DESK_SUBKIND.formOfflineLink` (`'form_offline_link'`; also add
  `formOfflineHoldExpired: 'form_offline_hold_expired'` in `packages/shared/src/testing/index.ts`), `blocking false`,
  `pinned false`, `subjectKey = 'form-offline:<requestId>'` (per case, never merged).
- Journey case: `projectId` = the instance's project, `addresseeUserId = defaultAddressee(tx, inst)` (GWP-67), so
  `mayManage` lets that person press Continue. Public-URL case: org level (Owner and Admins).
- Title from `offlineNoticeText`: `Secure link sent: <form title> (<client>)`. `client` = the origin link's reference
  (the firm's client number) and, with a journey, the record's display name. For the public URL: "a visitor of the
  public form". **The email address is never put in the item**; under A2 it is shown only through Show email.
- `data`: `{ requestId, formId, formTitle, clientReference, recordName, attemptedAt, linkSentAt, linkExpiresAt,
  instanceId, waitId, journeyName, stepId }`. `waitId` makes `endWaitSideEffects` close the item with the wait.
- **`queries/desk.ts` `toDeskDto` passes `data` only for whitelisted keys**: add the two subkinds and the keys above
  (strings only, as the journey keys are).
- `options`: `dismiss` only. The actions are block buttons (as `JourneyDeskItem` does), not desk options, so no new
  `resolveDeskItem` branch is needed.

Web: `apps/web/src/components/desk/FormOfflineLinkBlock.tsx` (new), used from `Desk.tsx` for both subkinds: facts table
(Client, Form, Journey and step, Tried at, Link sent at, Link expires, Submission received at / not yet), links to the
instance and the form, and the buttons:

- **Continue journey** (journey case, wait open): confirm dialog when no submission arrived ("No submission has arrived
  through the link yet. Continue the journey anyway? The secure link will stop working."), then
  `POST /api/journey-waits/:waitId/continue` (existing route, `useWaitAction`).
- **Show email** and **Resend link** (A2, Owner/Admin, case open): `POST /api/forms/offline-requests/:id/email` (returns
  `{ email }` with `cache-control: no-store`, appends `FormOfflineEmailViewed`) and
  `POST /api/forms/offline-requests/:id/resend` (status `sent`, link unused and unexpired, `resends < 3`; appends
  `FormOfflineLinkResent`). New route file `apps/server/src/routes/forms-offline.ts`, commands in
  `commands/forms-offline.ts`. The email is shown in the block until the item is closed and is not cached by the query
  client.
- **Cancel** (Owner/Admin, case open): `POST /api/forms/offline-requests/:id/cancel` → `cancelled`, email cleared, link
  revoked (journey case: the wait keeps running; its link is the revoked secure link, so the desk resends from the
  instance if needed).

### 4.6 Journey wait and continuation

`journey_waits` allows one wait per step visit, so the "documents pending, runner offline" wait is a **sub-state of the
form wait** of that visit, not a second wait row:

- On the offline request: `JourneyWaitOfflinePending` adds the timeline note "Documents pending, runner offline" at
  `attempted_at`.
- `listInstanceWaits` (`commands/journey-waits.ts`) adds `offline: { requestId, status, since, linkSentAt,
  linkExpiresAt } | null` to `WaitDto`, from the newest `form_offline_requests` row with this `journey_wait_id` (open
  cases first). No email.
- `InstanceWaitPanel.tsx`: when `w.offline` is open, a warning badge "Documents pending, runner offline" and the line
  "Runner offline since <since>", then after send "Secure link emailed <linkSentAt>, expires <date>". The step's own
  deadline and timeout action keep running as GWP-67 defines (waits are never silent).

Continue by itself: once the secure link is the wait's link (section 4.4 step 3), the submission through it is a normal
GWP-65 submission. `FormClientLinkUsed` sets `used_by_submission`, and GWP-67's `journeyTick` → `resolveFormWait`
resolves the wait (`form_submitted`), adds the record reference and advances the journey. No new resume function.

Desk or instance "Continue journey": GWP-67's guarded `continueWait` through the existing
`POST /api/journey-waits/:waitId/continue` (wait `FOR UPDATE`, `lockInstance`, refuses gates, `mayManage`).
`endWaitSideEffects` then revokes the unused secure link and closes the desk item. The sweep closes the case as
`continued` (step 8b). A client who opens the link after that gets the secure-link "no longer valid" sentence. The
earlier design kept the link valid after a manual continue; the landed `endWaitSideEffects` revokes it, and this design
follows the landed behaviour.

### 4.7 Public page (web: `apps/web/src/public-form/`)

| File | Change |
|---|---|
| `OfflinePanel.tsx` (new) | Firm logo and name, the message (section 3.3), one email input (`type="email"`, `inputMode="email"`, `autoComplete="email"`, `enterKeyHint="send"`, 16 px font so iOS does not zoom, 44 px tap targets), **Send me the link**, the honeypot and PoW from the session. On phones the panel is the only content and the field stays above the soft keyboard (`scrollIntoView({ block: 'center' })` on focus). Pre-fills the email from the form's first email field when the runner dropped mid-fill (a local value; the client confirms it) |
| `PublicFormPage.tsx` | New phases `offline` (from `availability` or a `runner_offline` reply at start, part or complete), `offline-sent`, `secure-link-offline` (secure link opened while offline again). On `runner_offline` the in-memory answers and files are dropped. The existing `later` phase stays for the hook |
| `api.ts` | `postOfflineRequest(publicId, body)` (`credentials: 'omit'`) |
| `messages.ts` | Sentences for `runner_online`, offline sent, and for a secure link (`link.purpose === 'offline'`): expired "This secure link has expired. Ask <firm> for a new one.", used "This secure link was already used to send this form.", revoked "This secure link is no longer valid. Ask <firm> for a new one." |

Accessibility: the panel has a heading, the message in an `aria-live="polite"` region after send, and the error text
tied to the field with `aria-describedby`.

### 4.8 Files to change (summary)

Server: `migrations/2850_forms_offline.sql` (new); `src/commands/forms-offline.ts` (new: sweep, resend, show email,
cancel); `src/routes/forms-offline.ts` (new, registered in `app.ts`); `src/public-forms/offline.ts` (new: route
handler); `src/public-forms/routes.ts` (register the route, `op 'offline'`, `onRequest` start check,
`destinationsOnline`, `availability`, `link.purpose`, shared session check); `src/public-forms/limits.ts` (two buckets);
`src/auth/secrets.ts` (`encryptFor/decryptFor`); `src/mail/templates.ts`; `src/scheduler/scheduler.ts` (`triggers()`);
`src/runner-gateway/handlers.ts` (`reconcile` → `onReconnect`); `src/projections/workstations.ts` (`connected_at`);
`src/projections/public-forms.ts` (link `purpose`, `offline_request_id`); `src/projections/journey-waits.ts`
(`JourneyWaitLinkSent` note for `offline_email`, `JourneyWaitOfflinePending` note); `src/projections/rebuild.ts`
(`SAVED` += `form_offline_requests`); `src/commands/public-forms.ts` (`createClientLinkIn` fields);
`src/commands/journey-waits.ts` (`WaitDto.offline`); `src/queries/desk.ts` (data whitelist); `src/config.ts`
(`publicForms.offline*`); `src/context.ts` (`formsOffline` service). Shared: `forms/offline.ts`, `forms/public.ts`
(`availability`, `link.purpose`), `events/forms-offline.ts`, `events/form.ts`, `events/journey-waits.ts` (`via`,
`JourneyWaitOfflinePending`), `events/index.ts`, `testing/index.ts` (`DESK_SUBKIND`), GWP-64
`FormSettings.offlineLinkDays`. Web: section 4.7 files, `components/desk/FormOfflineLinkBlock.tsx`, `pages/Desk.tsx`,
`components/forms/FormSettingsPanel.tsx`, `components/journeys/InstanceWaitPanel.tsx`, `api/queries/journeys.ts`
(`InstanceWait.offline`). Docs: `docs/security/public-forms.md` (threat rows T-off-1..5), `docs/SELF-HOSTING.md` (new
variables, held email retention), `CHANGELOG.md` `## [1.5.0]` (exists) → `### Added`. Runner: **no change**.

## 5. Risks and threats

| Risk | Handling |
|---|---|
| T-off-1 Inbox bombing through the offline panel | PoW + honeypot + min fill time, 3/hour per IP, 30/hour per form, 500 open per org, one open case per email per form; resend at most 3 times and only by an Owner/Admin |
| T-off-2 Email address leak from the DB | Encrypted (AES-256-GCM, purpose key, AAD), cleared when the case closes, never in events, logs or desk items; the dedupe hash is keyed and cleared too |
| T-off-3 Enumeration ("does this email have a case?") | Same 202 answer for new and duplicate |
| T-off-4 Link forwarded or reused | GWP-65 link rules: signed, expiring, consumed by the first completed submission, revocable; fragment-only token |
| T-off-5 Insider reads held emails (A2) | Show email only for Owner/Admin, on request, audited (`FormOfflineEmailViewed`), never cached in the item |
| Duplicate links on flapping or two server processes | Single claim `held → sending`, link created once and stored, desk item in the `sent` transaction |
| Crash after the email went out, before `sent` | The reclaimed row resends the **same** link (at most a duplicate email, never a second link) |
| Registry is per process (hosted, several instances) | The sweep reads `workstations.connected/connected_at`, not the in-memory registry |
| Form destinations change while a case is held | Workstations recomputed from the current published version before send; an unpublished form cancels the case |
| Wait link changed by a reminder or the desk while offline | The sweep revokes the wait's current link when it re-points the wait; a later desk "Resend link" closes the case `link_replaced` |
| Answers typed but lost | Expected under option B; the panel shows before the client starts (availability at load) |

## 6. Acceptance criteria → design → tests

All tests are new files. No existing test file is modified, and `e2e/**` is left to the testers.

| AC | Design | Tests |
|---|---|---|
| Offline submit shows the message and stores no answers or files | 4.3 (availability at load, `onRequest` 503 before the body, offline panel), 3.2 | `apps/server/test/forms-offline-no-content.test.ts`: runner offline, start with sentinel answers → 503 `runner_offline`; offline request with a sentinel email; dump every table (`SELECT t::text`) and captured logs: no answer sentinel anywhere, the email sentinel not in clear text anywhere (copy the method of `relay-no-content.test.ts`). Web `apps/web/src/test/public-form-offline.test.tsx`: offline availability renders the panel with no form fields; a 503 on start, part or complete switches to the panel |
| Instance shows the "documents pending, runner offline" wait with its start time | 4.6 | `apps/server/test/forms-offline-journey.test.ts`: link of a form wait, offline request → `listInstanceWaits` has `offline.since = attempted_at`, the timeline note, and the wait is still `open`. Web `apps/web/src/test/instance-wait-offline.test.tsx`: the badge and the since line |
| Reconnect: each pending client gets the email automatically (Mailpit), one desk notification per case with client, times, journey | 4.4, 4.5 | `apps/server/test/forms-offline-sweep.test.ts` (test mailer): two cases, mark the workstation connected past the settle delay, sweep → two mails with the link and firm name only, two desk items whose DTO `data` (through `toDeskDto`) holds the times and journey, no email in any desk row. `packages/shared/src/forms/offline.test.ts`: `offlineNoticeText`. Mailpit check: integration plan step 2 (testers) |
| Submitting through the link writes to storage and the journey continues; desk continue also moves it | 4.4 step 3, 4.6 | `forms-offline-journey.test.ts`: after the sweep the wait's `link_id` is the secure link and the old link is revoked; complete a submission through it (GWP-65 pipeline with the fake storage service) → `journeyTick` advances the instance, the next sweep marks the case `submitted` with the email cleared; second case: `continueWaitCmd` → instance moves, desk item closed, secure link revoked, case `continued`, repeated call refused `wait_not_open` |
| Mechanism written and confirmed before build | 3 | Manager's answer A2, ledger `fbe4e064-5c30-446a-8779-87ae8d11128d` (2026-11-03); link in the handoff |
| Expired or used secure link refused with a clear message | 4.7, GWP-65 link checks | `apps/server/test/forms-offline-link.test.ts`: past `expiresAt` → 410 `link_expired`, used → 410 `link_used`, revoked after continue → 410 `link_revoked`, tampered → 404, the definition reply has `purpose: 'offline'`; web `public-form-offline.test.tsx`: the secure-link sentences |
| CHANGELOG 1.5.0 entry | 4.8 | Review |
| Test plan 3: flapping sends one link per case | 4.4 | `forms-offline-sweep.test.ts`: connect → disconnect before settle → connect → sweep twice and in two concurrent calls → one mail, one link row, one desk item per case; a reclaimed `sending` row resends the same token |
| A2: show email and resend | 3.2, 4.5 | `apps/server/test/forms-offline-desk.test.ts`: Owner gets the email and a `FormOfflineEmailViewed` event without the email; a member is refused; resend sends the same link, the fourth is refused; after close both are refused and `email_enc` is NULL |
| Unit: queue, signing/expiry/single use, notification content | 4.1, 4.4, 4.5 | the files above, plus `apps/server/test/secrets-encrypt-for.test.ts` (AAD binding, purpose separation, round trip) and the `session_nonce` single-use case in `forms-offline-no-content.test.ts` |

Suites left for the testers: the Mailpit integration (stop the runner, submit, start the runner, read Mailpit, follow the
link) and the UAT phone run through the QR code.

## 7. Recommendation

Build A2 (section 3.2), as the manager confirmed: email only, encrypted with a purpose key, out of the event log, cleared
when the case closes, viewable and resendable from the desk by an Owner or Admin with an audit event. Detect the offline
runner before the client types (`availability`) and before the body is read (start `onRequest`). Send the links from an
idempotent scheduler sweep using SQL presence and a 30 s settle delay. The secure link is a GWP-65 client link with
`purpose 'offline'`; for a journey it becomes the form wait's link, so GWP-67's tick resumes the journey and its guarded
`continueWait` is the desk action. Raise one desk alert per case in the `sent` transaction.

## 8. Assumptions (final state after the review)

| Assumption | State |
|---|---|
| GWP-64 `FormSettings` accepts a new optional field without a version break | Not checked in this review (not in the review list); if it fails, keep the expiry as an org setting |
| Forms are org-scoped and journeys project-scoped | Holds in the landed code (`form_publications.org_id`, `journey_waits.project_id`) |
| The others | See section 9 |

## 9. Assumption review (2026-11-04)

| # | Assumption | Result | What changed |
|---|---|---|---|
| 1 | GWP-65 checks runner presence per destination workstation in the start route, and the check can run in `onRequest` before the body is read | **Did not hold as written.** The check is in the start handler, after the body is parsed and validated, and it only counts file fields that have a file. `onRequest` is shared, already resolves the publication and can do the check | Section 4.3: **add** a check to `onRequest` for `op 'start'` over all destinations, keep the handler's check, keep the default hook (503 `runner_offline`). The no-content test is unchanged |
| 2 | Client links (`form_client_links`, v1 HMAC token, `used_at`, 410 `link_expired`/`link_used`) exist and the create path can take `purpose` and `offlineRequestId` | **Holds.** `createClientLinkIn(tx, ctx, …)` is the in-transaction create path; `by` is a required user id | Two optional fields added; `by` = `started_by` or `published_by` |
| 3 | GWP-65 exposes reusable session/PoW/honeypot checks, a single-use session check and `KeyedBuckets` | **Partly.** `verifySession`, `powValid` and `KeyedBuckets` are exported; the check sequence is inline in the start handler; single use is only `form_submissions.session_nonce UNIQUE` | Section 4.3: one shared local check function in `routes.ts`; `form_offline_requests.session_nonce UNIQUE` instead of a `form_session_uses` table; two new `FormLimits` buckets |
| 4 | GWP-67 has a wait model with kinds, labels, start times, open/close and a guarded resume/continue, and its link carries the record reference | **Did not hold as written.** `journey_waits` is `UNIQUE (instance_id, visit)`, so no second wait can open on the visit; there is no `openWait`/`closeWait`/`resumeFormWait`/`findFormWait`. The guarded `continueWait` and the record reference on the link do exist | Section 4.6: the offline wait is a sub-state of the form wait (timeline event + `WaitDto.offline`); continue uses `continueWait` through the existing route; the per-instance offline continue route and the `resolveDeskItem` branch are dropped |
| 5 | Wait-for-form resumes on `FormSubmitted` matched by record and form | **Did not hold.** `journeyTick`/`resolveFormWait` resume only when the wait's own `link_id` is used | Section 4.4 step 3: the sweep re-points the wait to the secure link (`JourneyWaitLinkSent`, `via 'offline_email'`, old link revoked), so the existing tick resumes it; no new resume call |
| 6 | Storage connections are bound to one workstation (`storage_connections.workstation_id`) | **Holds** (`workstation_id uuid NOT NULL`, used by `connectionsOf`) | None |
