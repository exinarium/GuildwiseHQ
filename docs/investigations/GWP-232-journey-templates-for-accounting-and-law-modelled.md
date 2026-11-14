# GWP-232: Journey templates for accounting and law

## Question

Add one accounting journey template and one law journey template to the shared journey template catalogue. Model them on the real estate tenant template(s). Each needs a stable id, a name, a description and an industry tag. They must show in the Journeys gallery and work with the existing create-journey flow. Existing templates must not change.

Before modelling on it, check whether a real estate tenant template actually exists on the working branch (`main`).

## Findings

### F1. The reference template exists: it is `rentals`

`packages/shared/src/journeys/templates.ts` holds the whole catalogue, `JOURNEY_TEMPLATES`, and it has exactly one entry:

| field | value |
|---|---|
| id | `rentals` (`RENTALS_TEMPLATE_ID`) |
| name | `Rentals: lead to monthly rent` |
| recordType | `client` |
| steps | 10: 8 `workflow`, 1 `wait` (form upload, 5 days, remind ×2 then escalate), 1 `gate` (project owner approval) |
| handoffs | linear "done → next" from `build()`, plus cancelled/rejected → `end` and a `monthly_rent` done → `monthly_rent` loop |
| workflow keys | only shipped `business-*` keys (`business-enquiry`, `-follow-up`, `-document-request`, `-report`, `-quote`, `-reminder`) |

No template is named for real estate tenants, but `rentals` is that template: it follows a tenant from enquiry to monthly rent. The GWP-162 note ("only the Real estate rule pack") is out of date. Ledger 28ab23a7 already lists "the journey template 'Rentals: lead to monthly rent'" as a real estate piece. **Decision: `rentals` is the reference shape. No new real estate template is added.**

### F2. `JourneyTemplate` has no industry field

`interface JourneyTemplate { id; name; description; definition }`. The template is a plain TypeScript object served as JSON by `GET /api/journey-templates` (`apps/server/src/routes/journeys.ts:41`, returns `{ items: JOURNEY_TEMPLATES }`). It is never parsed by zod. An optional field on the interface therefore needs no schema change, no migration and no route change.

Rule packs already use an industry vocabulary: `RulePack.industry?: 'real_estate' | 'accounting' | 'law'` (`packages/shared/src/ledger/rule-packs.ts:36`). The sibling bundle card GWP-233 will join rule packs and journey templates by industry, so the template tag must use **the same values**.

### F3. Create-journey needs no change

`createJourney` (`apps/server/src/commands/journeys.ts:105`) does `getJourneyTemplate(templateId)`, returns 404 if it is missing, then `JourneyDefinitionSchema.parse(structuredClone(t.definition))`. New catalogue entries work through this path as they are. The web `pickTemplate` sends `{ projectId, templateId: t.id }`. Saving a journey is allowed even when validation has errors (it is a draft), so the form placeholder (`formId: null`) does not block creation. The same is already true for rentals.

### F4. Trap: the shared journeys test file never runs

`packages/shared/vitest.config.ts` has `include: ['test/**/*.test.ts']`. `packages/shared/src/journeys/journeys.test.ts`, which the brief names as the model, is **not collected**. Its rentals assertion, `validateJourney(...).errors` equal to `[]`, would fail if it ran: `packages/shared/test/journey-waits.test.ts:177` correctly expects `no_form` for rentals because its form wait has `formId: null`. **The new shared tests must go under `packages/shared/test/`**, or they are dead code and the AC "a unit test asserts this" is not met. Do not move or fix `src/journeys/journeys.test.ts` in this card (it is outside scope; see Follow-ups).

### F5. Trap: E2E selectors that more templates can break

- `e2e/tests/journeys.spec.ts:97`: `dialog.getByText('10 steps · for a client')`. Playwright matches text by substring under strict mode. A second client template with exactly 10 steps would match twice and fail. **The accounting template therefore has 11 steps.** The law template is `for a matter`, so it cannot collide. Line 101 already scopes the click to the rentals list item, so it is safe.
- `e2e/video/journeys.spec.ts:148`: `click(page, dialog.getByRole('button', { name: 'Use this template' }))` is **not** scoped. With three templates it hits three buttons, and `scrollIntoViewIfNeeded` throws a strict-mode error. No product-side change avoids this: the accessible name has to keep "Use this template" for `tests/journeys.spec.ts:102`. Builders may not edit E2E files, so the **tester must update that line** to the same pattern as `tests/journeys.spec.ts:98-102`: `dialog.getByTestId('journey-templates').getByRole('listitem').filter({ hasText: 'Rentals: lead to monthly rent' }).getByRole('button', { name: 'Use this template' })`.
- `apps/web/src/test/journeys-lib.test.ts:14` uses `JOURNEY_TEMPLATES[0]` as rentals. **New templates go after rentals in the array.**

### F6. Gallery

`JourneyTemplateGallery` shows name, description, "N steps · for a {recordType}" and a "Use this template" button for each template. With three templates, a filter control would add UI for no real gain. Browsing by industry belongs to GWP-234 (industry bundle UI). **Decision: no filter in this card.** Show a small industry badge on tagged templates so the tag is visible, and leave filtering to GWP-234, which can filter on `t.industry`.

## Options compared

| Topic | Option | Verdict |
|---|---|---|
| Industry tag | (a) optional `industry` on `JourneyTemplate` interface | **chosen**: no schema change, matches the brief and constraints |
| | (b) add to `JourneyDefinitionSchema` | rejected: changes stored journeys and the schema; the tag describes the catalogue entry, not the journey |
| Tag values | reuse rule-pack union `'real_estate' \| 'accounting' \| 'law'` | **chosen**: one vocabulary for GWP-233 |
| | new `'accounting' \| 'law'` only | rejected: diverges from rule packs; real estate could not be tagged later |
| Tag rentals as `real_estate` | yes | rejected **for this card**: AC says existing templates unchanged; GWP-233 may add it later (additive) |
| Gallery | badge only | **chosen** |
| | filter chips | deferred to GWP-234 |
| Template builder | reuse `build()` + `Spec` tuples | **chosen**: identical shape and handoff generation as rentals |

## Design

### Data model: `packages/shared/src/journeys/templates.ts`

```ts
import type { RulePack } from '../ledger/rule-packs.ts';

/** The industry a catalogue template is made for (same values as the industry rule packs). */
export type JourneyTemplateIndustry = NonNullable<RulePack['industry']>;

export interface JourneyTemplate {
  id: string;
  name: string;
  description: string;
  /** Absent: a general template. */
  industry?: JourneyTemplateIndustry;
  definition: JourneyDefinition;
}

export const RENTALS_TEMPLATE_ID = 'rentals';
export const ACCOUNTING_TEMPLATE_ID = 'accounting-client-onboarding';
export const LAW_TEMPLATE_ID = 'law-client-matter';
```

Leave the `rentals` entry byte-for-byte unchanged. Append the two new entries **after** it. `getJourneyTemplate` stays as it is (unknown id → `undefined`).

### Accounting template: 11 steps, `client`

- id `accounting-client-onboarding`, industry `accounting`
- name: `Accounting: client onboarding to filing`
- description: `A client from first enquiry through engagement letter, records collection, preparation, review, sign-off and filing, then the next period. Pick the form for the wait.`
- definition name `Accounting client`, definition description: `Enquiry, proposal, engagement letter, document request, records, preparation, review, sign-off, filing, invoice and next period.`

```ts
[
  ['enquiry', 'Enquiry', 'workflow', 'business-enquiry'],
  ['proposal', 'Scope and fee proposal', 'workflow', 'business-quote'],
  ['engagement_letter', 'Engagement letter signed', 'workflow', 'business-document-request'],
  ['document_request', 'Document request', 'workflow', 'business-document-request'],
  ['wait_documents', 'Wait for records and documents', 'wait', undefined, {
    waitFor: { kind: 'form', formId: null, purpose: 'upload', send: { via: 'desk' } },
    duration: { amount: 7, unit: 'days' },
    onTimeout: { action: 'remind', maxReminders: 2, afterLast: 'escalate' },
  }],
  ['preparation', 'Preparation', 'workflow', 'business-report'],
  ['review', 'Review', 'gate', undefined,
    { approver: { kind: 'project_owner' }, question: 'Is the work ready to send to the client for sign-off?' }],
  ['client_signoff', 'Client sign-off', 'workflow', 'business-document-request'],
  ['filing', 'Filing', 'workflow', 'business-follow-up'],
  ['invoice', 'Invoice', 'workflow', 'business-quote'],
  ['next_period', 'Close and plan the next period', 'workflow', 'business-reminder'],
],
[
  { from: 'enquiry', on: 'cancelled', to: 'end', label: 'Enquiry lost' },
  { from: 'engagement_letter', on: 'cancelled', to: 'end', label: 'Engagement declined' },
  { from: 'review', on: 'rejected', to: 'preparation', label: 'Changes needed' },
  { from: 'next_period', on: 'cancelled', to: 'end', label: 'Engagement ended' },
  { from: 'next_period', on: 'done', to: 'document_request', label: 'Next period' },
]
```

### Law template: 10 steps, `matter`

- id `law-client-matter`, industry `law`
- name: `Law: matter intake to close-out`
- description: `A matter from first enquiry through conflict check, engagement letter, client documents, matter work, review and close-out. Pick the form for the wait.`
- definition name `Law matter`, definition description: `Intake, conflict check, engagement letter, fee estimate, document request, documents, matter work, review, final invoice and close-out.`

```ts
[
  ['intake', 'Intake', 'workflow', 'business-enquiry'],
  ['conflict_check', 'Conflict check', 'workflow', 'business-report'],
  ['engagement_letter', 'Engagement letter signed', 'workflow', 'business-document-request'],
  ['fee_estimate', 'Fee estimate and deposit invoice', 'workflow', 'business-quote'],
  ['document_request', 'Document request', 'workflow', 'business-document-request'],
  ['wait_documents', 'Wait for client forms and documents', 'wait', undefined, {
    waitFor: { kind: 'form', formId: null, purpose: 'upload', send: { via: 'desk' } },
    duration: { amount: 7, unit: 'days' },
    onTimeout: { action: 'remind', maxReminders: 2, afterLast: 'escalate' },
  }],
  ['matter_work', 'Matter work', 'workflow', 'business-follow-up'],
  ['review', 'Review', 'gate', undefined,
    { approver: { kind: 'project_owner' }, question: 'Is the matter ready to close out?' }],
  ['final_invoice', 'Final invoice', 'workflow', 'business-quote'],
  ['close_out', 'Close-out', 'workflow', 'business-report'],
],
[
  { from: 'intake', on: 'cancelled', to: 'end', label: 'Enquiry lost' },
  { from: 'conflict_check', on: 'cancelled', to: 'end', label: 'Conflict found: matter declined' },
  { from: 'engagement_letter', on: 'cancelled', to: 'end', label: 'Engagement declined' },
  { from: 'review', on: 'rejected', to: 'matter_work', label: 'More work needed' },
  { from: 'close_out', on: 'done', to: 'end', label: 'Matter closed' },
]
```

Notes on the shapes:
- Same step kinds and config shapes as rentals: workflow steps with `business-*` keys, one form-upload wait with remind ×2 → escalate, one project-owner gate with a question. Step counts are 11 and 10 (rentals has 10).
- `build()` puts a step's non-`done` extras before its `done` handoff. An extra with `on: 'done'` replaces the default "done → next". That is how the `next_period` loop and the explicit `close_out → end` work, just as `monthly_rent` does.
- The gate rejections loop back to a workflow step, so `serverStepCycle` passes and `no_reject_handoff` is not raised.
- The text describes process steps only. None of it gives legal or accounting advice. None of it uses developer terms. GWP-29 business wording ("Knowledge", "Rules & decisions") is not affected, because no text mentions those areas.
- The 7-day wait (rentals has 5) reflects slower records collection. The shape is the same.

### Server

No product change. `GET /api/journey-templates` already returns the whole array, and the extra `industry` property passes through as JSON. `createJourney` already resolves any catalogue id.

### Web: `apps/web/src/components/journeys/JourneyTemplateGallery.tsx`

- Add a label map, `const INDUSTRY_LABEL: Record<JourneyTemplateIndustry, string> = { real_estate: 'Real estate', accounting: 'Accounting', law: 'Law' }`.
- When `t.industry` is set, render `<Badge>{INDUSTRY_LABEL[t.industry]}</Badge>` next to the name. Wrap the `h3` and the badge in a flex row that wraps on narrow screens. Put the badge in its **own** element, **not** inside the "N steps · for a …" paragraph, because E2E matches that text.
- Keep the button text "Use this template". On touch and small screens the grid already collapses to one column (`sm:grid-cols-2`). No input fields are added, so the soft keyboard is not affected.

`apps/web/src/pages/Journeys.tsx:112`: change the empty-state copy from "Start from the rentals template or build your own." to "Start from a template or build your own." No test asserts the old text (checked `e2e/` and `apps/web/src/test`).

No change to `useJourneyTemplates` (`apps/web/src/api/queries/journeys.ts`). `JourneyTemplate` is imported from `@aom/shared`, so it picks up `industry`.

### Tests

1. **New `packages/shared/test/journey-templates.test.ts`** (it must be under `test/`, see F4):
   - every `JOURNEY_TEMPLATES` entry: `JourneyDefinitionSchema.parse(t.definition)` succeeds and deep-equals `t.definition` (round trip); `firstStepId` is the first step.
   - ids unique; each id is non-empty kebab-case; name and description non-empty.
   - for every template: `validateJourney(t.definition, { enabledWorkflowKeys: Object.values(BUSINESS_WORKFLOW_KEY) }).errors.map(e => e.code)` equals `['no_form']` (the form is the only placeholder, as for rentals); warnings contain neither `no_reject_handoff` nor `unreachable`.
   - every workflow step key passes `isBusinessWorkflowKey`.
   - `getJourneyTemplate(ACCOUNTING_TEMPLATE_ID)?.industry === 'accounting'`, `getJourneyTemplate(LAW_TEMPLATE_ID)?.industry === 'law'`; recordType `client` and `matter`; `getJourneyTemplate('nope')` is `undefined`; `getJourneyTemplate('rentals')?.industry` is `undefined` (rentals unchanged).
   - pin both new step-id lists in order (as the rentals test does). Walk them with `nextMove`: accounting `review` + `{ result: 'cancelled', outcome: 'rejected' }` → `preparation`; `next_period` done → `document_request`; law `close_out` done → `{ kind: 'end' }`; `conflict_check` cancelled → end.
   - every template's `industry`, if set, is one of the rule-pack industries (`RULE_PACKS.flatMap(p => p.industry ?? [])`).
   - E2E guard: no template other than `rentals` has `recordType === 'client'` together with 10 steps (keeps `e2e/tests/journeys.spec.ts:97` unambiguous). Put a comment on it that names the E2E line.
2. **`apps/server/test/journeys-runtime.test.ts`** (integration, needs Postgres: testers run it): next to "creates the rentals template…", add an `it.each([ACCOUNTING_TEMPLATE_ID, LAW_TEMPLATE_ID])` test. It checks that `GET /api/journey-templates` lists the id with the right `industry`, that `POST /api/journeys { projectId, templateId }` → 201, and that `GET /api/journeys/:id` `definition.steps.map(s => s.id)` equals `getJourneyTemplate(id)!.definition.steps.map(s => s.id)` and `recordType` matches. Also check that an unknown `templateId` → 404 (current behaviour, not tested yet).
3. **New `apps/web/src/test/journey-template-gallery.test.tsx`**: render `JourneyTemplateGallery` with `JOURNEY_TEMPLATES` and a `vi.fn()` `onPick`. Assert the three names, the "Accounting" and "Law" badges, no badge on rentals, "11 steps · for a client" and "10 steps · for a matter". Clicking the button in the accounting list item calls `onPick` with the accounting template.
4. Regression: `packages/shared/test/journey-waits.test.ts` (rentals `no_form`) and `apps/web/src/test/journeys-lib.test.ts` (`JOURNEY_TEMPLATES[0]` = rentals) stay green without edits.

### E2E (tester, not builder)

`e2e/video/journeys.spec.ts:148`: scope the click to the rentals list item (F5). `e2e/tests/journeys.spec.ts` needs no change. Optional: an E2E case that creates a journey from the law template.

## Acceptance criteria → design

| AC | Covered by |
|---|---|
| Catalogue has ≥1 accounting and ≥1 law template with unique stable id, name, description, industry tag | two new entries + `industry` field; shared test (ids unique, fields, tags) |
| Each new template validates against the journey schema (unit test for every catalogue template) | `packages/shared/test/journey-templates.test.ts` parses every entry (under `test/`, so it runs) |
| `getJourneyTemplate` returns each new template; unknown id as before | unchanged function; shared test for both ids + unknown → `undefined`; server 404 test |
| Gallery lists accounting and law alongside existing | served by the existing route; gallery badge; web component test |
| Creating a journey from each new template via the existing route succeeds, steps match | no server change; server integration test compares step ids |
| Existing templates (rentals) unchanged, tests pass | rentals entry untouched and first in array; journey-waits + journeys-lib tests unchanged; shared test asserts rentals has no `industry`; E2E 10-steps guard; video spec fix by tester |

## Risks

- **Video E2E strict-mode break** (F5): the product change alone breaks it. This depends on the tester. Call it out in the build handoff.
- **Dead src test** (F4): a builder who follows the brief literally would add tests that never run. The design puts them in `test/`.
- **Ids are a contract** for GWP-233/234: never rename `accounting-client-onboarding` or `law-client-matter`.
- Size: about 150–200 changed lines, mostly data and tests. No migration and no API change. Not flagged large.

## Follow-ups (outside this card)

- `packages/shared/src/journeys/journeys.test.ts` is never run (vitest includes only `test/**`), and its rentals "errors equal []" assertion is wrong (`no_form`). It should be moved to `test/` and fixed. Suggested to the backlog.
- Whether to tag `rentals` as `real_estate`: decide in GWP-233 when the real estate bundle is defined (additive, optional field).
