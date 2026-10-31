# GWP-38 Web: manage inbound relay integrations and show the "runner offline, messages waiting at the provider" notice

Design for the web side of the inbound webhook relay (release 1.4.0, group business-workflows). Server, protocol and
runner work belong to GWP-36 (relay core, merged) and GWP-37 (WhatsApp handler). This card is mostly `apps/web`, plus
the small server and shared addition described in 5.8. That addition is needed because the landed status API has no
"last event" field (see section 0).

## 0. Assumption review against the landed GWP-36 code (2026-10-31)

I checked every assumption against `packages/shared/src/relay/index.ts`, `packages/shared/src/events/relay.ts`,
`apps/server/src/routes/relay-integrations.ts`, `apps/server/src/commands/relay-integrations.ts`,
`apps/server/src/webhook-relay/hub.ts`, `apps/server/migrations/2751_relay.sql`, `apps/runner/src/cli.ts`,
`apps/web/src/api/client.ts`, `apps/web/src/ws/invalidate.ts`, `packages/shared/src/orgs/mode.ts`,
`apps/web/src/components/shell/nav-config.ts`, the GWP-36 design report and the GWP-37 card facts.

| # | Assumption | Result | What changes |
|---|---|---|---|
| 1 | Shared kind enum and schemas for list, status and create/rotate | **Partly wrong** | The kind enum holds, as `RELAY_KINDS` / `RelayKindSchema` / `RelayKind`. The list item is `RelayIntegrationDtoSchema` (`id, orgId, kind, label, status, createdAt, rotatedAt, revokedAt`) and create/rotate is `RelayIntegrationWithUrlSchema` (`{ integration, url }`). The status is a **separate endpoint** with `RelayIntegrationStatusSchema` = `{ integrationId, connected, servingWorkstations, everServed, offlineSince, refusedSinceOffline: { count, lastAt } }`, and it covers **active integrations only**. There is **no `lastEventAt` and no last outcome**, and no exported list-response wrapper. The query merges list and status by id (5.3). The last event comes from a small additive server field (5.8). |
| 2 | Routes `/org/relay/integrations`, `/:id/rotate`, `/:id/revoke`; members GET, managers mutate | **Paths wrong**; roles hold | The real routes are `GET/POST /api/relay/integrations`, `GET /api/relay/integrations/status`, `POST /api/relay/integrations/:id/rotate` and `POST /api/relay/integrations/:id/revoke`. The web client adds `/api`, so the paths in `relay.ts` are `/relay/integrations…`. Create answers 201 `{integration,url}`, rotate answers `{integration,url}`, and revoke answers `{integration}`. A rotate or revoke on a revoked row is 409. **Both GETs answer 403 `business_mode_required` for a non-business org**, so the query must be disabled there (it already is: 5.3). |
| 3 | Create/rotate return the absolute URL; list and status never carry the token or a secret | **Holds** | `url = config.publicOrigin + '/relay/in/' + 'rly_…'`. The DTO has no token or hash, and the status has none either. Create is `.strict()`, so a secret key in the body is a 400. |
| 4 | Runner connect/disconnect raises WorkstationConnected/Disconnected; a relay stream is optional | **Partly wrong** (the fallback holds) | The workstation events exist, but they are **user-scoped** (`userScope(conn.userId)`), so only the workstation owner's browser receives them. The runner also announces `relay.serve` in a frame **after** `hello`, and serving, offline and refusals **emit no event** (`relay_presence` / `relay_requests` are plain tables). A `relay-<id>` stream exists, but only for Created/Rotated/Revoked. So for most members the **5 s poll while an active integration is offline** is what shows and clears the banner, as the fallback said. Still add the `relay` case in `ws/invalidate.ts`, so that create, rotate and revoke refresh other open tabs. |
| 5 | GWP-27 business flag + `/workstations` visible in business orgs | **Holds** | `isBusinessOrg(org)` from `@aom/shared` takes the **org** (`me.activeOrg`), not `me`. `lib/orgMode.ts` already has `useBusinessMode()`. The Workstations nav entry has no business gate. Use the shared helper directly and drop the local adapter. |
| 6 | GWP-37 gives the WhatsApp secrets CLI; Meta's retry window not confirmed | **Wrong on both halves** | (a) **The retry window is confirmed** in the merged GWP-36 report: Meta retries non-200 answers "for up to 7 days". So `RELAY_RETRY_WINDOW = { whatsapp_cloud: 'up to 7 days' }`. (b) GWP-37 is still in design (stage investigate), so the **secrets CLI command does not exist yet**. I record a dependency on GWP-37, so the step shows its real command and not a guess. (c) New, from GWP-36: a runner serves an integration only after `guildwise-runner relay add <integration-id> --kind <kind> [--label <text>]` and a restart, and only if the runner belongs to an Owner or Admin. Every kind's setup steps must show that command with the id filled in (5.5). |

Sections 2–9 below are the original design. I changed only what the review above makes wrong: the names, the paths,
the merged status, the last event, the retry text, the live-update wording, the serve command and the setup steps.

## 1. The question

How does an org manager of a business-mode org manage inbound relay integrations in the web app (list, create, rotate,
revoke, URL shown once, setup steps, no secret fields)? And how do org members see a "Runner offline: messages are
waiting at the provider" notice that comes and goes on its own, driven by the GWP-36 status API, with no polling faster
than the app's existing live updates?

## 2. Findings in the code

| Area | What is there | What it means here |
|---|---|---|
| `apps/web/src/pages/OrgSettings.tsx` | A tab list built in code: `general` and `members` for everyone, the rest only for `owner`/`admin`, plus extension tabs. An unknown `?tab=` falls back to `general`. | Add a `relay` tab when the org is business mode, for **all** roles (members see it read-only). A non-business org never gets the tab, and `?tab=relay` falls back to General. |
| `apps/web/src/components/shell/OrgBanner.tsx` | Pure component on props `{ me, project }`. Renders simulation, server `banners[]` and guest banners with `ui/Callout`. | It must **stay hook-free**: `simulation-banner.test.tsx` and cloud `billing-gate.test.tsx` render it without a `QueryClientProvider`. Pass the relay notice in as a new **optional** prop. |
| `apps/web/src/components/shell/AppShell.tsx` | `{me.data && <OrgBanner me={me.data} project={project} />}`. It already imports `isBusinessOrg` and computes `org`. | AppShell calls the new hook and passes the result in. |
| `apps/web/src/ws/invalidate.ts` | `keysForEvent` switches on `streamId.split('-')[0]`. The `workstation` case invalidates `['workstations']` and others. | Add `['relay']` to the `workstation` case (this helps the runner owner's own browser). Add `case 'relay': return [['relay']]` (GWP-36 streams are `relay-<integrationId>`). |
| `apps/web/src/api/client.ts` | `get(path, schema)` / `post(path, body)` fetch `/api${path}`. | Paths in `relay.ts` start with `/relay/…`. |
| `apps/web/src/api/queries/workstations.ts` | `useWorkstations` polls every 5000 ms. | 5 s is the fastest poll the app already uses. The relay poll uses 5 s, and only while something is offline. |
| `apps/web/src/api/queries/integrations.ts`, `pages/Integrations.tsx` | Workstation connectors (Jira, MCP …). | Name collision risk. New code is named `relay*` / `Relay*`, and the UI noun is "inbound webhook". |
| Secret shown once | `MembersTab.tsx` (temporary password dialog), `delivery/connect/CopyButton.tsx`, `ScheduleWizard.tsx`. | Reuse `CopyButton` and the MembersTab dialog layout. |
| Business-mode gate | `isBusinessOrg(org)` in `@aom/shared` (`orgs/mode.ts`); `useBusinessMode()` in `lib/orgMode.ts`. | Use them; no local adapter. |
| GWP-36 server | `routes/relay-integrations.ts`, `commands/relay-integrations.ts` (`relayStatuses`), `webhook-relay/hub.ts`. `relay_requests(at, integration_id, size_bytes, status, latency_ms, outcome, …)` has the index `(integration_id, at)`. While connected, the status zeroes `refusedSinceOffline` and nulls `offlineSince`. | The last event is one lateral lookup on an indexed table (5.8). |
| GWP-36 runner CLI | `guildwise-runner relay add <integration-id> --kind <kind> [--label <text>]`, `relay remove <id>`, `relay list`; each prints "Restart the runner to apply." The server accepts `relay.serve` only from a runner whose user is Owner/Admin of the org. | The setup steps show this command with the integration id, for every kind. The integration id is not a secret: the server checks membership on serve. |
| What's New | `whats-new/entries/*.md`, frontmatter `title, date, audience, help?, release?`. | A new entry with `audience: admin`, `release: 1.4.0`. |
| Component tests | Stub `fetch` with `vi.stubGlobal`, wrap in `QueryClientProvider` + `MemoryRouter`. | Same style. Add MSW dev-mock handlers. |
| Existing secret inputs elsewhere | `blog/SocialPanel.tsx`, `capabilities/PacksTab.tsx`, `AddCloudWorkstation.tsx`. | Unrelated to the relay; see D4. |

Ledger: the tester owns `e2e/**`. An existing test file that is edited but not named in Affected areas trips
`out_of_scope_test_change`, so the builder **adds new test files**.

## 3. Decisions

- **D1 "since when"**: when the serving runner went offline (`offlineSince`). If that is null (an integration that no
  runner ever served, `everServed: false`), fall back to `refusedSinceOffline.lastAt`. Wording: "since 14:02" for
  today, otherwise `formatDateTime`.
- **D2 one source of truth**: the GWP-36 status endpoint alone decides "serving runner connected" (`connected`).
  Workstation events are only a trigger to refetch.
- **D3 retry window**: `RELAY_RETRY_WINDOW: Partial<Record<RelayKind, string>> = { whatsapp_cloud: 'up to 7 days' }`
  (confirmed in the GWP-36 report from Meta's Cloud API webhook guide). If the notice covers kinds without an entry, or
  more than one kind, the text is "The provider retries for a limited time."
- **D4 scope of "no input for a provider secret"**: this means **relay provider secrets**. No relay surface may have
  such a field, and no relay request or response may carry one. The existing unrelated inputs (blog social tokens,
  pack repo token, cloud workstation token) are out of scope. The builder states this reading in the handoff.
- **D5 (new) last event**: the card asks for the "last event time and result from metadata". The landed API does not
  have it, so add one additive nullable field to the status (5.8): metadata only (time, outcome, HTTP status, size).

## 4. Options compared

### 4.1 Where the banner gets its data

**B. Hook in AppShell, notice passed as an optional `relayOffline` prop to OrgBanner** (unchanged). OrgBanner stays
pure, and the existing banner tests pass unchanged.

### 4.2 How the status stays live

**Event invalidation + conditional poll** (unchanged choice, new weighting): while at least one active integration has
`connected: false`, poll both relay GETs every **5 s** (the same as `useWorkstations`). While everything is connected,
there is no interval, only events and window focus. The landed code emits **no event** for serve, offline or refusal,
and the workstation events reach only the runner owner's browser. So for org members the poll is what shows the banner
after a refusal and clears it after a reconnect (within about 5 s, without a reload). That meets AC 3.

### 4.3 Where the page lives

A tab on `/settings/org` (`?tab=relay`, label "Inbound webhooks").

## 5. Design

### 5.1 Files

New:
- `apps/web/src/api/queries/relay.ts`: queries and mutations (5.3).
- `apps/web/src/lib/relay.ts`: pure helpers `RELAY_KIND_LABEL`, `RELAY_OUTCOME_LABEL`, `RELAY_RETRY_WINDOW`,
  `RELAY_WHATSAPP_CLI` (from GWP-37), `relayServeCommand(row)`, `mergeRelay(list, statuses)`,
  `relayOfflineNotice(rows)`, `relayRowState(row)`, `offlineActive(row)`.
- `apps/web/src/components/orgsettings/RelayTab.tsx`, `RelayCreateDialog.tsx`, `RelayUrlDialog.tsx`,
  `RelaySetupSteps.tsx` (the steps, used in the URL dialog and in the tab).
- `apps/web/src/components/shell/RelayOfflineCallout.tsx`.
- `apps/web/src/whats-new/entries/<build date>-inbound-webhooks.md`.
- Tests: `apps/web/src/test/relay-integrations.test.tsx`, `apps/web/src/test/relay-banner.test.tsx`,
  `apps/web/src/test/relay-lib.test.ts`, and for 5.8 `apps/server/test/relay-status-last-event.test.ts`.

Changed:
- `apps/web/src/pages/OrgSettings.tsx`: add the tab (5.2).
- `apps/web/src/components/shell/OrgBanner.tsx`: optional prop `relayOffline?: RelayOfflineNotice | null`.
- `apps/web/src/components/shell/AppShell.tsx`: `const relayOffline = useRelayOfflineNotice(org)`, passed on.
- `apps/web/src/ws/invalidate.ts`: `['relay']` in the `workstation` case; new `case 'relay': return [['relay']]`.
- `apps/web/src/mocks/handlers-*.ts`: dev mock for the five endpoints.
- `packages/shared/src/relay/index.ts` and `apps/server/src/commands/relay-integrations.ts`: the additive `lastEvent`
  field (5.8).
- Existing tests that must stay green **unchanged**: `simulation-banner.test.tsx`, `whats-new.test.tsx`,
  `integrations.test.tsx`, `socket-noise.test.ts`, `lib.test.ts`, cloud `billing-gate.test.tsx`, and the server's
  `relay-integrations.test.ts`, `relay-endpoint.test.ts`, `relay-no-content.test.ts`.

### 5.2 Gate and roles

```tsx
// OrgSettings.tsx
const business = isBusinessOrg(me.data?.activeOrg); // @aom/shared
const tabs = [
  { id: 'general', label: 'General' },
  { id: 'members', label: 'Members' },
  ...(business ? [{ id: 'relay', label: 'Inbound webhooks' }] : []),
  ...(manager ? [/* existing manager tabs */] : []),
];
{tab === 'relay' && business && <RelayTab canManage={manager} />}
```

- Non-business org: no tab, and `?tab=relay` falls back to General. The queries are disabled, so the 403s are never
  requested.
- Member: list, status and setup text, with **no** Create, Rotate or Revoke buttons (not rendered).
- The server enforces the same rules.

### 5.3 API layer (`api/queries/relay.ts`)

Use the GWP-36 schemas from `@aom/shared`. Only the response wrappers are local, because GWP-36 exports none:

```ts
import {
  RelayIntegrationDtoSchema, RelayIntegrationStatusSchema, RelayIntegrationWithUrlSchema,
  type RelayIntegrationCreate,
} from '@aom/shared';

const ListSchema = z.object({ integrations: z.array(RelayIntegrationDtoSchema) });
const StatusSchema = z.object({ statuses: z.array(RelayIntegrationStatusSchema) });
const RevokeSchema = z.object({ integration: RelayIntegrationDtoSchema });

export const relayKey = ['relay'] as const;
export const RELAY_OFFLINE_POLL_MS = 5000; // == useWorkstations; never lower

/** The org's inbound webhooks merged with their live status (metadata only: never a URL token, never content). */
export function useRelayIntegrations(enabled = true) {
  return useQuery({
    enabled,
    queryKey: [...relayKey, 'integrations'],
    queryFn: async () => {
      const [list, status] = await Promise.all([
        get('/relay/integrations', ListSchema),
        get('/relay/integrations/status', StatusSchema),
      ]);
      return mergeRelay(list.integrations, status.statuses); // lib/relay.ts
    },
    // Serving, offline and refusals emit no event, so poll lightly while an active integration has no runner.
    refetchInterval: (q) => (q.state.data?.some(offlineActive) ? RELAY_OFFLINE_POLL_MS : false),
  });
}

export const useCreateRelayIntegration = () => /* post('/relay/integrations', body) -> RelayIntegrationWithUrlSchema */;
export const useRotateRelayIntegration = () => /* post(`/relay/integrations/${id}/rotate`) -> RelayIntegrationWithUrlSchema */;
export const useRevokeRelayIntegration = () => /* post(`/relay/integrations/${id}/revoke`) -> RevokeSchema */;
// each onSuccess: qc.invalidateQueries({ queryKey: relayKey })

export function useRelayOfflineNotice(org: Me['activeOrg'] | null | undefined) {
  const q = useRelayIntegrations(!!org && isBusinessOrg(org));
  return useMemo(() => relayOfflineNotice(q.data), [q.data]);
}
```

One fetch of both GETs under one key keeps the banner and the tab consistent. A 409 on rotate or revoke (already
revoked in another tab) shows the server message and refetches.

**The URL token stays out of every cache.** For create and rotate, call `mutateAsync`, put `url` into the dialog's
local `useState`, then call `mutation.reset()` at once. Never `setQueryData` with it, and never put it in a toast,
`console`, the URL bar, `localStorage` or an error report. Closing the dialog clears the state.

### 5.4 Pure rules (`lib/relay.ts`)

```ts
export type RelayRow = RelayIntegrationDto & { live: RelayIntegrationStatus | null }; // null: revoked (no status row)

export const mergeRelay = (list: RelayIntegrationDto[], statuses: RelayIntegrationStatus[]): RelayRow[] => {
  const byId = new Map(statuses.map((s) => [s.integrationId, s]));
  return list.map((i) => ({ ...i, live: i.status === 'active' ? byId.get(i.id) ?? null : null }));
};

export const offlineActive = (r: RelayRow) => r.status === 'active' && r.live !== null && !r.live.connected;

export type RelayOfflineNotice = {
  items: { id: string; label: string; kind: RelayKind; since: string }[];
  retryText: string; // D3
};

/** Banner rule (AC 3, AC 4): active + no serving runner + at least one refused event since it went offline. */
export function relayOfflineNotice(rows: RelayRow[] | undefined): RelayOfflineNotice | null {
  const items = (rows ?? [])
    .filter((r) => offlineActive(r) && (r.live?.refusedSinceOffline.count ?? 0) > 0)
    .map((r) => ({
      id: r.id, label: r.label, kind: r.kind,
      since: (r.live?.offlineSince ?? r.live?.refusedSinceOffline.lastAt) as string,
    }));
  if (items.length === 0) return null;
  const kinds = new Set(items.map((i) => i.kind));
  const window = kinds.size === 1 ? RELAY_RETRY_WINDOW[items[0].kind] : undefined;
  return { items, retryText: window ? `The provider retries for ${window}.` : 'The provider retries for a limited time.' };
}

/** Row status: revoked | runner offline | connected. AC 4: offline without refusals is a row state only. */
export function relayRowState(r: RelayRow): 'revoked' | 'runner_offline' | 'connected'

export const relayServeCommand = (r: Pick<RelayRow, 'id' | 'kind'>) =>
  `guildwise-runner relay add ${r.id} --kind ${r.kind}`;
```

An active row whose status is missing (a race between the two GETs) counts as "runner offline" for the row text. It
gives no banner, because it has no refused count.

### 5.5 Integrations tab (`RelayTab.tsx`)

Panel intro: "A private web address per provider. Guildwise HQ passes each request straight to the runner on your
workstation and keeps only the time, size and result. Secrets stay on your workstation."

Per row (a table at `sm` and up, stacked cards on phones with `useIsMobile`), `data-testid="relay-row-<id>"`:

| Field | Source |
|---|---|
| Label | `label` |
| Kind | `RELAY_KIND_LABEL[kind]` (WhatsApp Cloud API, Form webhook, Incoming webhook, Calendar push, Generic) |
| Status | `relayRowState`: "Active · runner connected" (ok, with "on N workstations" if `servingWorkstations > 1`), "Active · runner offline" (warning; plus "No runner has served it yet" when `everServed` is false), "Revoked" (neutral, with `revokedAt`) |
| Created | `formatDate(createdAt)`; "address rotated <date>" beneath it if `rotatedAt` |
| Serving runner connected | yes/no, `data-testid="relay-runner-<id>"` |
| Last event | `live.lastEvent` (5.8): `agoText(at)` + `RELAY_OUTCOME_LABEL[outcome] ?? outcome` + HTTP status + size ("2 min ago · forwarded · 200 · 1.2 KB", "runner offline · 503"). "No requests yet" when null. **Never** body, headers or query. Revoked rows show "–". |
| Runner command | `relayServeCommand(row)` in a `<code select-all>` + `CopyButton` (all roles; the id is not a secret) |
| Actions (managers, active rows) | "Rotate address" (ConfirmDialog: "The old address stops working at once. Update it at the provider."), "Revoke" (ConfirmDialog, danger: "Requests to this address get 'not found'. This cannot be undone.") |

Revoked rows come after the active ones, with no actions. There is a "New inbound webhook" button for managers
(`relay-new`). Empty state: "No inbound webhooks yet" + the button (managers), or "An Owner or Admin can add one"
(members).

**Create dialog** (`RelayCreateDialog`): a native `Select` over `RELAY_KINDS` and a `TextInput` label (required,
trimmed, max 80, the same as `RelayIntegrationCreateSchema`). These are the **only two inputs** on the relay surfaces.
The body is exactly `{ kind, label }`, because the server schema is `.strict()`. On success, the URL dialog opens.

**URL dialog** (`RelayUrlDialog`, for create and rotate): title "Copy the address for <label>". Description: "This
address is shown once. Copy it now: it cannot be shown again. If you lose it, rotate the address to get a new one."
`<code select-all break-all data-testid="relay-url">` + `CopyButton testId="relay-url-copy"`. "Done" closes it and
clears the state. Below that come `<RelaySetupSteps integration={…} />`.

**Setup steps** (`RelaySetupSteps`, in the URL dialog and in each row under a `Disclosure` "Setup steps"):
- Every kind (step "Serve it from your workstation"): "On the workstation that runs your runner (signed in as an Owner
  or Admin), run `guildwise-runner relay add <id> --kind <kind>` and restart the runner." Show it with a copy button.
- `whatsapp_cloud`, additionally:
  1. In Meta for Developers, open your app → WhatsApp → Configuration → Webhook, and paste the address as the
     **Callback URL**. (In the tab, where the address is not available any more: "paste the address you copied when
     you created or rotated it".)
  2. Choose a **verify token** yourself. You type it in Meta and on your workstation, never here.
  3. On that workstation, enter the app secret and the verify token with `RELAY_WHATSAPP_CLI` (the command from GWP-37,
     verbatim; dependency recorded). They are stored encrypted on that workstation.
  4. Click **Verify and save** in Meta. Your runner answers Meta's check through Guildwise HQ.
  5. Subscribe to the **messages** field.
- Other kinds: "Paste the address as the webhook URL at the provider."

Touch and soft keyboard (standing order "design"): the label field gets `autoFocus` (the user types into it anyway).
The kind select is native. The buttons use the kit sizes (44 px targets on mobile), and the dialogs are the kit
`Dialog` (a sheet on phones). The long URL and the command wrap (`break-all`).

### 5.6 Offline notice (`RelayOfflineCallout.tsx`)

```tsx
<Callout tone="warning" role="status" title="Runner offline: messages are waiting at the provider"
         data-testid="relay-offline-banner">
  No runner serving {names} is connected {since}. Requests are refused so the provider keeps them and sends them
  again. {retryText} Start the runner on your workstation to receive them.{' '}
  <Link to="/workstations" className="font-medium underline" data-testid="relay-offline-link">Open Workstations</Link>
</Callout>
```

- `names`: `<strong>` labels joined. With several integrations, each has its own "since …" (`<ul>` when more than 2).
- Shown to **all** members of the active org.
- It may show the refused count ("3 requests refused"): `refusedSinceOffline.count` is metadata. It never shows
  content, headers or byte counts.

### 5.7 What's New

```md
---
title: Inbound webhooks for WhatsApp and forms
date: <build date>
audience: admin
release: 1.4.0
---
Business organizations can give WhatsApp, web forms and calendars a private address that passes each message straight to the runner on your workstation. Guildwise HQ keeps no message content and no secrets, and tells you when messages are waiting because the runner is offline.
```

### 5.8 Server: last event in the status (new, additive)

`packages/shared/src/relay/index.ts`:

```ts
export const RelayLastEventSchema = z.object({
  at: z.iso.datetime(),
  outcome: z.string(),          // one of RELAY_OUTCOMES; string so an older or newer value never breaks the parse
  status: z.number().int(),     // the HTTP status the provider got
  sizeBytes: z.number().int(),
});
// RelayIntegrationStatusSchema: add
lastEvent: RelayLastEventSchema.nullable(),
```

`apps/server/src/commands/relay-integrations.ts` `relayStatuses`: add

```sql
LEFT JOIN LATERAL (SELECT q.at, q.outcome, q.status, q.size_bytes FROM relay_requests q
                    WHERE q.integration_id = i.id ORDER BY q.at DESC, q.id DESC LIMIT 1) le ON true
```

and map it to `lastEvent: le.at ? { at: iso(le.at), outcome, status, sizeBytes } : null`. It uses the existing index
`relay_requests_integration_at`. Rows are pruned after the retention period, so `null` also means "nothing in the
last N days". There is no new table and no content: every column is already stored.

Test (new file `apps/server/test/relay-status-last-event.test.ts`, with the `helpers/relay.ts` and `world` helpers):
no request → `lastEvent: null`; a refused POST (no runner) → `{ outcome: 'runner_offline', status: 503 }`; a forwarded
POST → `forwarded` with the runner's status. The response JSON has no `body`, `headers` or `query` keys. This suite
needs the test Postgres that the existing relay suites use. If it is not available in the sandbox, name the file in the
handoff for the tester.

## 6. Acceptance criteria → design → test

| AC | Design | Test (new files) |
|---|---|---|
| 1 Manager creates each kind, URL once + copy, rotate, revoke, list updates | 5.3 mutations + `['relay']` invalidation; 5.5 dialogs; kinds from `RELAY_KINDS` | `relay-integrations.test.tsx`: for each of `RELAY_KINDS`, create → the POST body is exactly `{kind,label}`, `relay-url` shows the URL, and copy calls `navigator.clipboard.writeText`. Close → the URL is gone from the DOM, and the refetched list has none. Rotate → new URL once. Revoke → confirm → POST `/api/relay/integrations/<id>/revoke`, and the row shows Revoked after the refetch. |
| 2 No secret input; WhatsApp steps point to the runner CLI | Only kind + label; `RELAY_WHATSAPP_CLI` + `relayServeCommand`; D4 | Same file: no `input[type=password]`, and no input/textarea whose label or name matches `/secret\|token\|verify\|access/i`. The only inputs are label + kind. The WhatsApp steps contain `RELAY_WHATSAPP_CLI` and `guildwise-runner relay add <id> --kind whatsapp_cloud`. A fetch spy: no relay request body has keys matching `/secret\|token/i`. |
| 3 Offline + one refused → banner naming integration + since; clears on reconnect without reload | 5.4, 5.6, 4.2 poll | `relay-banner.test.tsx`: OrgBanner with a notice shows the title, label and since. Live: the hook with stubbed fetch returning `connected:false, refusedSinceOffline:{count:1}` → banner; switch the stub to `connected:true` and advance fake timers by 5 s → banner gone (no remount). `relay-lib.test.ts`: `keysForEvent` for `workstation-…` and `relay-…` includes `['relay']`. |
| 4 Offline, no refused → row "runner offline", no banner | `relayRowState`; the rule needs `count > 0` | `relay-lib.test.ts` rule table (connected / offline+0 / offline+1 / offline+1 with `offlineSince:null` uses `lastAt` / revoked) → only active offline+1 gives a notice. `relay-integrations.test.tsx` row text "runner offline". `relay-banner.test.tsx` no banner. |
| 5 Members read-only; non-business no page | 5.2 | `relay-integrations.test.tsx`: a member sees the rows and no Create/Rotate/Revoke. A non-business `me` → no tab, `?tab=relay` shows General, and no `/api/relay` request is made. |
| Req 1 "last event time and result" | 5.5 + 5.8 | `relay-integrations.test.tsx` row shows outcome and status from `lastEvent`; server test above. |
| Req 2 retry window | D3 | `relay-lib.test.ts`: a WhatsApp-only notice says "up to 7 days"; mixed kinds use the generic text. |
| Existing tests | Optional prop, no hook in OrgBanner, additive field | Existing banner, What's New and GWP-36 server tests pass unchanged. |

E2E (card test plan) is the **tester's** under `e2e/**`. The builder adds the `data-testid`s (`relay-tab`, `relay-new`,
`relay-url`, `relay-url-copy`, `relay-row-<id>`, `relay-runner-<id>`, `relay-offline-banner`, `relay-offline-link`) and
lists the E2E as left for the tester. The tester's runner must run `guildwise-runner relay add <id> --kind …` and
restart before the POST.

## 7. Risks

- **GWP-37 not merged**: the WhatsApp secrets command is unknown. A dependency on GWP-37 is recorded, so the build
  waits for it. The rest of the design does not depend on it.
- **Members learn of a reconnect only through the poll** (no event): up to 5 s of delay, acceptable for AC 3.
- **A never-served integration polls every 5 s** while the tab or shell is open in a business org. This costs the same
  as `useWorkstations`, so it is acceptable.
- **The URL token lingering in memory or caches**: local state + `mutation.reset()`, and a test that the DOM is clean
  after close.
- **The server change widens the card** beyond `apps/web`: it is additive and nullable, and covered by a new server
  test.

## 8. Assumptions

All checked against the landed code in section 0. The only open item is GWP-37's command (dependency recorded).

## 9. Recommendation

Build as designed. Add the `relay` tab in org settings and a pure, prop-driven notice in OrgBanner, both fed by one
query that merges `GET /api/relay/integrations` with `GET /api/relay/integrations/status`. The query refreshes on
`workstation-*` / `relay-*` events and polls every 5 s only while an active integration is offline. Add one nullable
`lastEvent` field to the status for the row's last event. The URL is held only in the dialog's local state. There is no
secret field anywhere. The setup steps show `guildwise-runner relay add <id> --kind <kind>` for every kind, plus
GWP-37's secrets command for WhatsApp. The retry text for WhatsApp is "up to 7 days".
