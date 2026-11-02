# GWP-64 Forms builder: drag-and-drop form designer with company logo, basic fields and field properties

Status: design, ready to build (2026-11-03). Target branch: `release/1.5.0`. Repository: GuildwiseHQ.
Scope: designing, previewing and saving forms. Publishing a form at a public URL is GWP-65; storage connections are
GWP-63; journeys and wait-for-form (GWP-66, GWP-67) read the definition designed here. No form answers are stored.

## 1. The questions

1. What shape does a form definition have (typed shape or JSON Schema), and how is it versioned per organisation?
2. Where does the shared validation live so the builder preview, the public form (GWP-65) and the server use one function?
3. How does the server store and version forms in this event-sourced codebase?
4. Where is the company logo stored (requirement 8: the architect decides and records it)?
5. How do drag and drop and keyboard reordering work without a drag library?
6. Which web files, routes and tests change, and which existing tests are affected?

## 2. Findings in the code

| Where | What is there | Use for this card |
|---|---|---|
| `packages/shared/src/workflows/*`, `packages/shared/src/attachments/index.ts` | Zod schemas are the source of truth for definitions, with pure validators beside them, exported from `packages/shared/src/index.ts` | Same layout: `packages/shared/src/forms/` |
| `workflow_versions` (migration 0005, 1000) | Versioned definitions as `(org_id, key, version)` + `definition jsonb` | Same idea, but forms get their own tables (no approval states, no stages) |
| `packages/shared/src/events/relay.ts`, `apps/server/src/projections/relay.ts`, migration 2751 | Recent small org-scoped domain: events + projector + table, writes use the event time, `ON CONFLICT DO NOTHING` | Template for the form events and projector |
| `apps/server/src/commands/avatar.ts`, migration 1308 (`avatar_images`) | Uploaded image bytes in an operational table, written by the command before its event, no foreign key, not truncated by a rebuild; magic-byte check (`pngSize`) | Template for the logo store |
| `apps/server/src/routes/card-attachments.ts` (`serveAttachment`, raw-body parser), migration 1780 | Raw-body upload with a per-route body limit; served with `nosniff`, sandbox CSP, `cross-origin-resource-policy` | Upload and serve the logo the same way |
| `apps/server/src/auth/guards.ts` `requireOrg(ctx, req, { min })` | Org from `X-AOM-Org` or session; 403 for non-members | Every forms route |
| `apps/web/src/components/ProjectRankList.tsx` | Native HTML5 drag (`draggable`, `onDragStart/Over/Drop`), a grip button that answers ArrowUp/Down/Home/End, Move up/down buttons, `aria-live` announcements, focus restored after a move | **The house pattern** for the canvas; no library |
| `docs/design/workflow-builder.md` D1 | "ordered list, not a free canvas; reorder by buttons plus drag as an enhancement; works on phones and with screen readers" | The canvas is an ordered list of field cards |
| `apps/web/src/pages/WorkflowBuilderPage.tsx` | `beforeunload` guard for unsaved changes; `LargerScreenNote` on phones | Reuse both |
| `apps/web/src/components/shell/nav-config.ts`, `apps/web/src/lib/videos.ts`, `apps/web/src/test/section-videos.test.tsx` | Every sidebar entry must have a `SECTION_VIDEOS` entry; unrecorded ones are `published: false` and listed in the test's `waiting` set (precedent: Boardroom, commit 8cecf4af) | A `forms` entry, waiting for GWP-70 to record the video |
| `apps/web/src/help/pageHelp.ts`, `apps/web/src/test/help.test.tsx` | Every route needs a `PAGE_HELP` entry (`page-help-content.ts`) | Add `/forms` and `/forms/:id` |
| GWP-63 design (branch `aom/gwp-63-…`, `docs/investigations/GWP-63-…md`) | `GET /api/org/storage/connections` (any member, "GWP-64 uses it"); template keys `journey, client, form, field, submission, date, time, original, ext`; `STORAGE_MAX_FILE_BYTES` 25 MiB; migration `2810_storage_connections.sql` | The destination picker reads this list; template keys match; migration number above 2810 |
| `CHANGELOG.md` | `## [Unreleased]` then `## [1.4.0] - 2026-11-01`; the release scanner's heading regex allows a heading without a date | Add `## [1.5.0]` (no date) between them |
| `apps/web/package.json` | React 19, zod 4, no drag library | No new dependency |

## 3. Options and decisions

### D1. Definition shape: a Zod-typed shape, JSON Schema derived from it

| Option | For | Against |
|---|---|---|
| **A. Zod schema in `packages/shared` is the source of truth; JSON Schema generated with `z.toJSONSchema()`** (chosen) | One definition for types, parsing and validation in browser and server; every other domain here does it; zod 4 is already used, and `z.toJSONSchema` is already used in `packages/shared/test/direct-model.test.ts` | — |
| B. Hand-written JSON Schema + Ajv | Language neutral | New dependency, a second type definition to keep in sync, no TypeScript types |
| C. Store a JSON Schema of the *answers* as the form | Standard | Cannot express layout, help text, upload destinations or logo; GWP-65/67 would still need a UI shape |

The definition carries `schemaVersion: 1` so a later shape change is a new literal plus an upgrade function, never an
edit of stored events. `formDefinitionJsonSchema()` exports the JSON Schema for external readers (webhooks in GWP-67).

### D2. Versioning: every save is a new immutable version

- A form has an id and versions 1..n. **A version is never edited.** Save = append `FormVersionSaved` with `version =
  latest + 1`. Old versions stay readable by `GET /api/forms/:id/versions/:n`.
- Save carries `baseVersion`; if another save happened in between: 409 `form_version_conflict` ("This form was changed
  by someone else. Reload to see version N."). No silent overwrite.
- Save of an unchanged definition (same canonical hash) returns the latest version and appends nothing (no version
  churn from repeated Save clicks).
- No autosave (it would create a version per keystroke); explicit **Save** with a dirty marker and a `beforeunload`
  guard, as in `WorkflowBuilderPage`.
- Rejected: a mutable draft plus published versions. It is what GWP-65 needs for "published", but this card has no
  publish, and AC 5 says "editing a saved form creates a new version". GWP-65 adds a `published_version` pointer on
  `forms` (new optional event field / new event), and submissions record `formId + version` (requirement 6).

### D3. One validation module in `packages/shared/src/forms`

`validateFieldAnswer` / `validateFormAnswers` are pure functions with no DOM and no Node imports. The builder preview
imports them from `@aom/shared`; GWP-65 calls the same functions on the public page and in the server route; the server
in this card uses `validateFormDefinition` on save. Messages are produced by the shared module too, so the preview and
the public form show the same words.

### D4. Logo: an organisation branding image stored on the Guildwise server (decision to record)

| Option | For | Against |
|---|---|---|
| **A. Operational table `org_brand_images` on the server (bytes in Postgres, like `avatar_images`), the form references `logo.imageId`** (chosen) | Shown in the builder and on the public form without a runner online; small; same pattern as avatars and card attachments; branding is the organisation's public identity, not client data (requirement 8) | The hosted service holds the image bytes; acceptable because it is a public branding asset the firm chose to show to the public, not client data, credentials or answers |
| B. In the firm's storage via the runner (GWP-63) | Nothing on Guildwise servers | Public form and preview break when the runner is offline; every page view becomes a runner relay; GWP-63 is a write-only path |
| C. Inline data URL in the definition | No table | Bytes inside every `FormVersionSaved` event (event log growth with each version); event payloads should stay small |
| D. The vault | Allowed store | Same runner-offline problem as B for the public page |

Rules: PNG, JPEG or WebP only (magic bytes checked on the server; the client's content type is ignored); **SVG
refused** (a public, directly opened SVG can run script); at most 512 KB; bytes never enter the event log; images are
never deleted while a version references them (old versions must stay renderable), so this card has no delete. Served
to signed-in members of the owning organisation only; GWP-65 adds the public read for logos referenced by a published
version. **Record:** "The form logo is an organisation branding asset stored on the Guildwise server in
`org_brand_images` (PNG/JPEG/WebP, max 512 KB, no SVG). It is not client data; client answers and uploads never go
there." I posted it on the card thread; the BA should record it in the ledger at finalize.

### D5. Drag and drop: native HTML5 drag plus keyboard and buttons, no library

| Option | For | Against |
|---|---|---|
| **A. Native HTML5 drag + grip with arrow keys + Move up/down buttons + tap/Enter to add** (chosen) | Already in the codebase (`ProjectRankList`) and tested there; no dependency; keyboard and screen-reader path is first class | HTML5 drag events are weak on touch screens: touch users use tap-to-add and the buttons |
| B. `@dnd-kit/core` + `sortable` | Pointer + touch + keyboard sensors, good a11y | New dependency in an open-source product (licence and audit), second drag pattern in the app |
| C. Own pointer-events engine | Full touch drag | Most code, most bugs; buttons already cover touch |

Touch and phones (standing order "all devices, including touch"): every action has a tap path. Palette items are
buttons (tap or Enter adds the field after the selected field, or at the end); every field card has Move up, Move down,
Duplicate, Delete buttons (44 px targets, `size-10` like `ProjectRankList`). On phones the page shows
`LargerScreenNote`, the three panels stack, and the property panel opens below the selected field so the soft keyboard
does not cover the input being typed into (no bottom sheet for text inputs; scroll the focused input into view).

## 4. Design

### 4.1 Shared: `packages/shared/src/forms/` (new), exported from `packages/shared/src/index.ts`

Files: `schema.ts` (types, limits, defaults), `validate.ts` (answers), `definition.ts` (definition checks, field
factory, canonical form), `api.ts` (request/response DTO schemas), `index.ts` (re-exports).

```ts
export const FORM_FIELD_TYPES = ['short_text','long_text','email','phone','number','date',
  'dropdown','radio','checkbox','file'] as const;
export const FORM_LIMITS = { fields: 100, options: 200, label: 200, placeholder: 200, helpText: 500,
  description: 4000, confirmation: 2000, shortText: 1000, longText: 20000, fileTypes: 30,
  fileMaxBytes: 25 * 1024 * 1024 /* = GWP-63 STORAGE_MAX_FILE_BYTES */, logoBytes: 512 * 1024 } as const;
export const FORM_TEMPLATE_KEYS = ['journey','client','form','field','submission','date','time','original','ext'] as const;

const FieldId = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);          // generated 'f_' + 8 base36, stable across versions
const Base = { id: FieldId, label: z.string().trim().min(1).max(200), required: z.boolean().default(false),
               helpText: z.string().max(500).optional() };
const Placeholder = { placeholder: z.string().max(200).optional() };
const Options = { options: z.array(z.string().trim().min(1).max(200)).min(1).max(200) };   // unique, case-insensitive
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);              // plus a real-calendar check in definition.ts

export const FormDestinationSchema = z.object({
  connectionId: z.uuid().nullable(),          // null = not set (allowed until GWP-63 lands, and later)
  folder: z.string().max(400),                // template, e.g. 'Forms/{form}/{submission}'
  name: z.string().max(200),                  // template, e.g. '{field}-{original}'
});

export const FormFieldSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('short_text'), ...Base, ...Placeholder, minLength: Int0.optional(), maxLength: Int1.max(1000).optional() }),
  z.object({ type: z.literal('long_text'),  ...Base, ...Placeholder, minLength: Int0.optional(), maxLength: Int1.max(20000).optional() }),
  z.object({ type: z.literal('email'),      ...Base, ...Placeholder }),
  z.object({ type: z.literal('phone'),      ...Base, ...Placeholder }),
  z.object({ type: z.literal('number'),     ...Base, ...Placeholder, min: z.number().finite().optional(), max: z.number().finite().optional() }),
  z.object({ type: z.literal('date'),       ...Base, min: IsoDate.optional(), max: IsoDate.optional() }),
  z.object({ type: z.literal('dropdown'),   ...Base, ...Placeholder, ...Options }),
  z.object({ type: z.literal('radio'),      ...Base, ...Options }),
  z.object({ type: z.literal('checkbox'),   ...Base, ...Options }),   // a group: answer = selected options
  z.object({ type: z.literal('file'),       ...Base,
    allowedTypes: z.array(z.string().regex(/^(\.[a-z0-9]{1,10}|[a-z]+\/([a-z0-9.+-]+|\*))$/)).min(1).max(30),
    maxSizeBytes: z.number().int().min(1).max(FORM_LIMITS.fileMaxBytes),
    destination: FormDestinationSchema }),
]);

export const FormSettingsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(4000).default(''),          // plain text, line breaks kept; no Markdown/HTML
  logo: z.object({ imageId: z.uuid(), alt: z.string().max(200).default('') }).nullable().default(null),
  answersDestination: FormDestinationSchema,              // where GWP-65 writes the text answers
  confirmationText: z.string().trim().min(1).max(2000),
});
export const FormDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  settings: FormSettingsSchema,
  fields: z.array(FormFieldSchema).max(100),              // order = display order
});
```

`FIELD_TYPE_META: Record<FormFieldType, { label: string; properties: readonly FieldProperty[] }>` drives the palette
labels and which inputs the property panel shows (`label, required, placeholder, helpText, minLength/maxLength,
min/max (number), min/max (date), options, allowedTypes, maxSizeBytes, destination`). `newFormField(type, id)` returns
the defaults: file = `allowedTypes ['.pdf','.jpg','.jpeg','.png']`, `maxSizeBytes` 10 MiB, destination
`{ connectionId: null, folder: 'Forms/{form}/{submission}', name: '{field}-{original}' }`; choice fields get
`['Option 1','Option 2']`. `newFormDefinition(title)`: no fields, answers destination
`{ connectionId: null, folder: 'Forms/{form}', name: '{date}-{submission}' }`, confirmation "Thank you. We have received
your answers."

`definition.ts`:
- `validateFormDefinition(input: unknown): { ok: true; definition } | { ok: false; issues: FormDefinitionIssue[] }` where
  `FormDefinitionIssue = { path: string; fieldId?: string; message: string }`. Zod parse, then: field ids unique; options
  unique (case-insensitive); `minLength ≤ maxLength`, `min ≤ max`; dates are real calendar dates; templates use only
  `{key}` with keys in `FORM_TEMPLATE_KEYS` (`{{`/`}}` literal), no `..` segment, no leading `/`. Rendering and
  sanitising stay in GWP-63's `renderStoragePath`; this check is only the syntax the builder can show inline.
- `canonicalFormDefinition(def)`: the parsed object serialised with the schema's key order (deterministic JSON), used for
  the "unchanged" check (server hashes it with sha256).
- `formDefinitionJsonSchema()`: `z.toJSONSchema(FormDefinitionSchema, { io: 'input' })`.

`validate.ts` (the one validation module, AC 6):

```ts
export type FormFileAnswer = { name: string; size: number; type: string };   // metadata only; no bytes
export type FormAnswerValue = string | number | string[] | FormFileAnswer | null | undefined;
export type FormFieldErrorCode = 'required'|'too_short'|'too_long'|'invalid_email'|'invalid_phone'|'not_a_number'
  |'below_min'|'above_max'|'invalid_date'|'date_before_min'|'date_after_max'|'invalid_option'|'file_type'
  |'file_too_large'|'invalid_value';
export interface FormFieldError { code: FormFieldErrorCode; message: string }
export function validateFieldAnswer(field: FormField, value: FormAnswerValue): FormFieldError | null;
export function validateFormAnswers(def: FormDefinition, answers: Record<string, FormAnswerValue>,
  opts?: { strict?: boolean }): { ok: boolean; errors: Record<string, FormFieldError>; unknown: string[] };
```

Rules (empty = `undefined`, `null`, `''` after trim, `[]`; an empty optional field is valid and skips the other rules):

| Type | Rules and messages |
|---|---|
| all | required + empty → `required` "This field is required." |
| short/long text | length after trim; `too_short` "Enter at least N characters." / `too_long` "Enter at most N characters." The type cap (1000 / 20000) applies even without `maxLength` |
| email | ≤ 254 chars and `/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/` → `invalid_email` "Enter a valid email address, such as name@example.com." |
| phone | remove spaces, `-`, `.`, `(`, `)`; optional leading `+`; 7 to 15 digits (E.164 length) → `invalid_phone` "Enter a valid phone number, such as +27 82 123 4567." |
| number | string or number; `/^-?\d+(\.\d+)?$/` after trim, finite → else `not_a_number` "Enter a number."; inclusive range → `below_min`/`above_max`: "Enter a number between 1 and 10." when both are set, else "…of at least 1." / "…of at most 10." |
| date | `YYYY-MM-DD` and a real date → else `invalid_date`; inclusive range → `date_before_min` "Pick a date on or after 1 Jan 2026." / `date_after_max` (dates formatted by a fixed English formatter in the module, not the locale, so server and browser agree) |
| dropdown, radio | value must equal one option → `invalid_option` "Choose one of the options." |
| checkbox | `string[]`, every value an option, no duplicates → `invalid_option`; required = at least one |
| file | type matches an entry: `.ext` compares the file name's last extension (lower case); `type/sub` compares the MIME type, `type/*` its prefix → else `file_type` "This file type is not allowed. Allowed: PDF, JPG, PNG."; `size > maxSizeBytes` → `file_too_large` "The file is too large (12.4 MB). The limit is 10 MB." |
| wrong value shape | `invalid_value` "This answer is not valid." |

`strict: true` (the server in GWP-65) also lists answer keys that are not fields in `unknown` and sets `ok=false`.
Note for GWP-65: the browser's file name and type are client input; the server must also check the real bytes (magic
numbers) before it accepts an upload. This card's module covers what the declared metadata allows.

`api.ts` (DTO schemas, as other domains do):
`FormSummaryDto { id, title, latestVersion, status: 'active'|'archived', fieldCount, updatedAt, updatedByName }`,
`FormDto { id, status, latestVersion, definition, versions: Array<{ version, savedAt, savedByName }> }`,
`FormVersionDto { formId, version, definition, savedAt, savedByName }`,
`CreateFormRequestSchema { definition }`, `SaveFormRequestSchema { baseVersion: int ≥ 1, definition }`,
`FormLogoDto { imageId, url }`, `formLogoUrl(imageId) = /api/forms/logos/<id>`.

### 4.2 Events: `packages/shared/src/events/form.ts` (new), registered in `events/index.ts`

Stream `form-<formId>` (add `streamId.form` in `packages/shared/src/ids.ts`), `orgScope(orgId)`, `userActor(by)`.

- `FormVersionSaved { formId, orgId, version: int ≥ 1, definition: FormDefinitionSchema, definitionHash: sha256 hex, by }`
  — version 1 is the creation.
- `FormArchived { formId, orgId, by }`, `FormUnarchived { formId, orgId, by }` — hide or show the form in the list;
  versions stay readable.

No event for the logo bytes (operational, like `avatar_images`); the definition references `logo.imageId`.

### 4.3 Server

**Migration** `apps/server/migrations/2820_forms.sql` (GWP-63 takes 2810; use the next free number at build time):

```sql
-- Forms builder (docs/investigations/GWP-64-…md). forms, form_versions: projections of FormVersionSaved / FormArchived /
-- FormUnarchived (rebuilt from events). org_brand_images: operational bytes (never in the event log), no foreign key,
-- kept over a projection rebuild. No form answers are stored anywhere in this schema.
CREATE TABLE IF NOT EXISTS forms (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL,
  title           text NOT NULL,
  latest_version  integer NOT NULL,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  field_count     integer NOT NULL,
  created_by      uuid,
  created_at      timestamptz NOT NULL,
  updated_by      uuid,
  updated_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS forms_org ON forms (org_id, status, updated_at DESC);
CREATE TABLE IF NOT EXISTS form_versions (
  form_id          uuid NOT NULL,
  version          integer NOT NULL,
  org_id           uuid NOT NULL,
  definition       jsonb NOT NULL,
  definition_hash  text NOT NULL,
  saved_by         uuid,
  saved_at         timestamptz NOT NULL,
  event_seq        bigint NOT NULL,
  PRIMARY KEY (form_id, version)
);
CREATE TABLE IF NOT EXISTS org_brand_images (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL,
  purpose       text NOT NULL DEFAULT 'form_logo',
  content_type  text NOT NULL,
  size          integer NOT NULL,
  sha256        text NOT NULL,
  data          bytea NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS org_brand_images_org ON org_brand_images (org_id);
```

**Projector** `apps/server/src/projections/forms.ts` (`formProjectors`, registered in `projections/index.ts`; add
`'forms'` and `'form_versions'` to `PROJECTION_TABLES`; `org_brand_images` is not a projection table). Writes use the
event time. `FormVersionSaved`: insert `form_versions … ON CONFLICT DO NOTHING`; upsert `forms` with `title =
definition.settings.title`, `field_count`, `latest_version = GREATEST(existing, version)`, `updated_*` (only when the
version is the newest). `FormArchived/Unarchived`: set `status`. Replay-safe.

**Commands** `apps/server/src/commands/forms.ts`:
- `createForm(ctx, who, definition)`: `validateFormDefinition` (422 `invalid_form` with `issues`), logo check (below),
  new id, append version 1 in `withAppendTx`.
- `saveForm(ctx, who, formId, { baseVersion, definition })`: in `withAppendTx`, `SELECT … FROM forms WHERE id=$1 AND
  org_id=$2 FOR UPDATE` (404 when missing or another org); `baseVersion !== latest_version` → 409
  `form_version_conflict` with `latestVersion`; validate; hash `canonicalFormDefinition` → equal to the latest
  `definition_hash` → return `{ form, created: false }`; else append `version + 1`, return `{ form, created: true }`.
- `archiveForm` / `unarchiveForm`.
- Logo check on create and save: `settings.logo.imageId` must exist in `org_brand_images` with the same `org_id`, else
  422 `logo_not_found`.
- `uploadFormLogo(ctx, who, bytes)`: size ≤ 512 KB (413-style 422 `logo_too_large`), magic bytes PNG
  (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`) or WebP (`RIFF….WEBP`) else 422 `logo_type` ("Use a PNG, JPEG or WebP
  image."); content type from the magic bytes; insert row; return id.

**Queries** `apps/server/src/queries/forms.ts`: list (by org, `status`, newest first, joined to `users` for the display
name), get (latest + version list), get version. Every query filters by `org_id` of the request.

**Routes** `apps/server/src/routes/forms.ts` (`formRoutes(ctx)`, registered in `app.ts` after `cardAttachmentRoutes`).
All use `requireOrg(ctx, req, …)`. Reads: any member. Writes: Owner and Admin (`min: 'admin'`), the same level as
workflows, roles and storage connections; publishing in GWP-65 can keep it. A form of another organisation answers
**404** (not 403: no existence leak).

| Method and path | Who | Result |
|---|---|---|
| `GET /api/forms?status=active\|archived` | member | `{ forms: FormSummaryDto[] }` |
| `POST /api/forms` `{ definition }` | admin | 201 `FormDto` (version 1) |
| `GET /api/forms/:id` | member | `FormDto` (latest definition + version list) |
| `GET /api/forms/:id/versions/:version` | member | `FormVersionDto`; 404 for an unknown version |
| `PUT /api/forms/:id` `{ baseVersion, definition }` | admin | 200 `{ form: FormDto, created }`; 409 `form_version_conflict`; 422 `invalid_form` / `logo_not_found` |
| `POST /api/forms/:id/archive`, `POST /api/forms/:id/unarchive` | admin | 204 |
| `POST /api/forms/logos` (raw body, `bodyLimit` 512 KB + 16 KB, own content-type parser inside an encapsulated plugin as in `documents.ts`) | admin | 201 `FormLogoDto` |
| `GET /api/forms/logos/:imageId` | member of the image's org | bytes with `content-type` from the row, `x-content-type-options: nosniff`, `content-security-policy: sandbox; default-src 'none'`, `cache-control: private, max-age=86400, immutable` (an id never changes content), `cross-origin-resource-policy: same-origin` |

The web client sends `X-AOM-Org`; the `<img>` of the logo relies on the session's active org (cookie), like avatars.

No answers route, no submission table: nothing in this card stores answers (constraint).

### 4.4 Web

New files:
- `apps/web/src/api/queries/forms.ts`: `useForms(status)`, `useForm(id)`, `useFormVersion(id, v)`, `useCreateForm`,
  `useSaveForm`, `useArchiveForm`, `uploadFormLogo(file)`, `useStorageConnections()` (GET
  `/api/org/storage/connections`; a 404 — GWP-63 not merged yet — resolves to `[]` and the picker shows only "Not set").
- `apps/web/src/lib/formBuilder.ts` (pure, unit-tested): `insertField(fields, field, at)`, `moveField(fields, id, to)`
  (same semantics as `moveTo` in `ProjectRankList`), `duplicateField(fields, id, newId)` (copy placed after, label
  "… (copy)"), `removeField`, `newFieldId()` (`'f_' + 8 base36`, unique in the form).
- `apps/web/src/pages/Forms.tsx`: list (title, fields, version, updated by/at), **New form** (admins), Active/Archived
  tabs, Archive/Unarchive in a row menu, `EmptyState` when there are none.
- `apps/web/src/pages/FormBuilderPage.tsx`: route `/forms/:id` (`/forms/new` for a new, unsaved form; the first Save
  POSTs and replaces the URL with the id). Tabs **Build** and **Preview** (`components/ui/Tabs.tsx`); on `xl` screens
  Build shows palette | canvas | property panel; Preview renders `FormRenderer` in a centred frame with a
  Desktop/Phone width toggle. Header: title, "Version N", **Save** (disabled when clean or invalid; shows the
  definition issues inline at the field they belong to), a **Versions** menu ("Version 2 — 3 Nov, Pieter") that opens
  `/forms/:id?version=2` read-only (banner "You are looking at version 2. The latest is version 3."). 409 → toast with
  **Reload**. `beforeunload` guard while dirty. Members see Preview and the read-only canvas only. `LargerScreenNote`
  for editors on phones.
- `apps/web/src/components/forms/FieldPalette.tsx`: ten buttons from `FIELD_TYPE_META` with an icon each (lucide:
  for example `Type`, `AlignLeft`, `Mail`, `Phone`, `Hash`, `Calendar`, `SquareChevronDown`, `CircleDot`,
  `SquareCheck`, `Upload`; use the names the installed lucide-react exports).
  `draggable`, `dataTransfer.setData('application/x-form-field-type', type)` (and `text/plain` for Firefox); click or
  Enter inserts after the selected field or at the end and selects it.
- `apps/web/src/components/forms/FormCanvas.tsx`: an `<ol>` of field cards (compact read-only rendering of the field,
  label, required marker, type badge). Per card: grip button (`draggable` card; ArrowUp/ArrowDown/Home/End move it,
  focus stays on the grip, as in `ProjectRankList`), Move up, Move down, Duplicate, Delete (Delete with undo toast).
  Drop targets: between cards (an insertion line as in `ProjectRankList`) and the empty canvas ("Drag a field here or
  pick one from the list"); a drop of a palette type inserts a new field at that index; a drop of a card moves it.
  Click/Enter on a card selects it. `aria-live="polite"` announces "Email moved to position 3 of 7", "Phone added at
  position 4".
- `apps/web/src/components/forms/FieldProperties.tsx`: inputs for the selected field, shown by
  `FIELD_TYPE_META[type].properties`: Label, Required, Placeholder, Help text, Min/Max length (text), Min/Max value
  (number), Earliest/Latest date (date), Options (textarea "one option per line": easiest on touch and keyboard),
  Allowed file types (chips PDF, Images (jpg, jpeg, png, heic), Word (doc, docx), Excel (xls, xlsx) plus a text input
  for other extensions), Size limit in MB (1 to 25), Destination connection (select; "Not set" first), Folder and File
  name templates with the allowed `{keys}` listed under them. Issues from `validateFormDefinition` show under the
  input. No field selected → `FormSettingsPanel`.
- `apps/web/src/components/forms/FormSettingsPanel.tsx`: title, description, logo (file input `accept="image/png,
  image/jpeg,image/webp"`; the browser refuses > 512 KB with a message before upload; thumbnail; alt text; Remove),
  answers destination (connection, folder, name), confirmation text.
- `apps/web/src/components/forms/FormRenderer.tsx`: **the** rendering of a form as a client sees it, with no app
  chrome; GWP-65 reuses it on the public page. Props `{ definition, logoUrl?: string, mode: 'preview' | 'public',
  onSubmit?(answers) }`. Logo at the top (`<img>` max height 80 px, alt from settings or the title), title,
  description (line breaks kept, rendered as text), fields in order with `<label for>`, help text
  (`aria-describedby`), native inputs (`type=email`, `tel`, `number`, `date` with `min/max`, `select`, radio group in
  `<fieldset><legend>`, checkbox group, `type=file` with `accept` from `allowedTypes`). Validation with
  `validateFieldAnswer` on blur and `validateFormAnswers` on submit; errors next to each field (`aria-invalid`,
  `role="alert"` text) and an error summary at the top that links to each field; focus moves to the summary. Use
  `noValidate` on the `<form>` so the shared messages, not the browser's, show. Preview submit with no errors shows the
  confirmation text and "Preview only: nothing was sent." Files are never read or uploaded in preview (only
  `name/size/type`).

Changed files:
- `apps/web/src/router.tsx`: `/forms` → `Forms`, `/forms/:id` → `FormBuilderPage`.
- `apps/web/src/components/shell/nav-config.ts`: Work section, after Automations: `{ id: 'forms', label: 'Forms', to:
  '/forms', icon: ClipboardList, testId: 'nav-forms' }` (every member; writes are guarded by role).
- `apps/web/src/lib/videos.ts`: `forms: { title: 'Forms: build a form', nav: 'forms', help: 'forms#build-a-form',
  published: false }` with the comment the other unrecorded entries had (GWP-70 records the video and flips it).
- `apps/web/src/help/articles/forms.md` (new article, frontmatter as `boardroom.md`): sections `{#build-a-form}`,
  `{#field-types}`, `{#preview}`, `{#versions}`, `{#company-logo}`. GWP-70 extends the guide.
- `apps/web/src/help/page-help-content.ts`: entries for `/forms` and `/forms/:id`.
- `CHANGELOG.md`: add `## [1.5.0]` (no date) between `## [Unreleased]` and `## [1.4.0] - 2026-11-01`, `### Added`,
  one entry: "Forms builder. Owners and Admins design forms under Work > Forms: drag fields from a palette (short text,
  long text, email, phone, number, date, dropdown, radio, checkbox, file upload) or add them with a tap or the keyboard,
  reorder, duplicate and delete them, and set label, required, placeholder, help text, min/max, options and upload
  types, size limit and destination. The form settings add a title, description, company logo, a destination for the
  answers and a confirmation text. A live preview shows the form as a client will see it, with the same validation
  messages. Every save is a new version; earlier versions stay readable. Migration 2820." (Keep the wording plain;
  GWP-69/70 also add to this heading: expect a merge conflict on it.)

### 4.5 Risks and traps

| Risk | Handling |
|---|---|
| A saved version edited in place | No UPDATE of `form_versions` anywhere; the projector inserts only; a test asserts v1 is unchanged after v2 |
| Lost update by two editors | `baseVersion` check under `FOR UPDATE` in the append transaction → 409 |
| Cross-org reads (forms, versions, logos) | Every query filters by the request's org; 404 for other orgs; tests for each route |
| Logo as an attack vector on the public page | No SVG, magic-byte check, sandbox CSP + nosniff on serve, 512 KB |
| HTML/script in labels or descriptions | Rendered as React text only (no `dangerouslySetInnerHTML`, no Markdown) |
| Event log growth | Definition ≤ 100 fields, capped string lengths; no logo bytes in events; unchanged saves append nothing |
| Template keys drift from GWP-63 | `FORM_TEMPLATE_KEYS` equals GWP-63's list; if `packages/shared/src/storage` has merged when you build, import its key list instead of declaring a second one |
| `/api/org/storage/connections` missing (GWP-63 not merged) | Picker treats 404 as no connections; `connectionId: null` is valid |
| Sidebar entry without a recorded video breaks `section-videos.test.tsx` | Unpublished entry + `waiting` set, the Boardroom precedent (8cecf4af) |
| Native drag does not work on many touch screens | Tap-to-add and Move up/down buttons on every card (all devices) |
| Number input locale (comma decimals) | `type=number` gives a dot-decimal string; the shared rule accepts dot decimals only, and says "Enter a number." |
| Migration number clash with sibling cards | Use 2820 or the next free number at build time; never edit an applied migration |

## 5. Acceptance criteria → design → tests

| AC | Design | Test |
|---|---|---|
| 1. Create a form, add all 10 types by drag and drop, reorder, save; reopening shows the same fields in order | `FieldPalette` + `FormCanvas` (drop at index), `formBuilder.ts`, `POST/PUT /api/forms`, projector keeps array order in `definition` | `apps/web/src/test/forms-builder.test.tsx`: drag each of the 10 palette items onto the canvas (`fireEvent.dragStart/dragOver/drop` with a `dataTransfer` stub), reorder by drag and by grip ArrowDown, Save sends the fields in order; reopen with the mocked GET shows the same order. `apps/web/src/test/form-builder-lib.test.ts` for insert/move/duplicate/remove. `apps/server/test/forms.test.ts`: create, read back, field order equal |
| 2. Each property can be set and is honoured by the preview | `FieldProperties`, `FormSettingsPanel`, `FormRenderer` reads the same definition | `forms-builder.test.tsx`: set label, required, placeholder, help text, min/max, options, upload types, size limit, folder/name; switch to Preview and assert each (label text, `required` marker, placeholder attribute, help text, `min/max` attributes, options rendered, `accept` attribute, the size limit in the help line); destination folder/name saved in the PUT body |
| 3. Preview rejects empty required, invalid email, number outside min/max, disallowed upload type and over-size upload, with a message per field | `validateFormAnswers` in `FormRenderer`, error per field + summary | `apps/web/src/test/form-renderer.test.tsx` (each case, `userEvent.upload` with `new File([...], 'x.exe', …)` and a `File` whose `size` is over the limit); `packages/shared/test/forms-validation.test.ts` every type and rule |
| 4. Logo at the top of the preview | `settings.logo.imageId` → `formLogoUrl` → first element of `FormRenderer` | `form-renderer.test.tsx` asserts the `<img>` with the logo URL is the first element; `forms.test.ts` upload PNG ok, SVG/text refused, > 512 KB refused, other-org logo refused on save and on GET |
| 5. Editing a saved form creates a new version; the previous stays readable | D2, `saveForm`, `GET /versions/:n`, Versions menu | `forms.test.ts`: save → v2; GET v1 returns the old definition unchanged; unchanged save → still v2; stale `baseVersion` → 409; rebuild of projections gives the same rows. `forms-builder.test.tsx`: Versions menu opens v1 read-only |
| 6. One shared validation module used by the preview and exported for the server (a unit test imports it from the shared package) | `packages/shared/src/forms/validate.ts` exported from the package index; `FormRenderer` imports from `@aom/shared`; the server imports `validateFormDefinition` | `packages/shared/test/forms-validation.test.ts` imports from `../src/index.ts` (the package entry, as every shared test does); `apps/server/test/forms-shared-validation.test.ts` (no database) imports `validateFormAnswers` from `@aom/shared` |
| 7. CHANGELOG 1.5.0 entry | §4.4 | `apps/server/test/release-changelog-parity.test.ts` still passes (existing, unchanged) |

Other tests: `packages/shared/test/forms-definition.test.ts` (schema limits, unique ids and options, min ≤ max, real
dates, template keys, canonical JSON stable across key order, `formDefinitionJsonSchema()` produces an object schema);
`forms.test.ts` also: member cannot write (403), another org gets 404 on list/get/version/put/archive/logo, archive hides
from the active list, invalid definition 422 with issues; `apps/web/src/test/forms-list.test.tsx` (list, New form for
admins only, archive).

Existing test files the builder will modify (name them in the handoff):
- `apps/web/src/test/section-videos.test.tsx`: count 32 → 33 and add `forms` to the `waiting` / `publish(...)` lists as
  done for Boardroom (the current file has no waiting set; restore the pattern from 8cecf4af).
- Possibly `apps/web/src/test/tour.test.tsx` only if a tour step is added (not required here; leave the tour to GWP-70).

Run: `cd packages/shared && npx vitest run`, `cd apps/web && npx vitest run`, `pnpm -r typecheck`,
`npx biome check --write <paths>`. Server tests need Postgres (`CLAUDE.md`): run `test/forms.test.ts`,
`test/rebuild.test.ts` and `test/forms-shared-validation.test.ts` if the database is available, otherwise name them for
the testers. Do not touch `e2e/**`.

## 6. Out of scope (other cards)

Publishing, public URL, QR code, per-client links, server-side answer validation on submit, upload byte sniffing,
public logo serving (GWP-65); storage connections and template rendering (GWP-63); journeys referencing
`formId + version` (GWP-66/67); user guide and video (GWP-70); hosted service routes (GWP-69). guildwise-cloud needs no
change for this card: the routes are core routes behind the normal session.
