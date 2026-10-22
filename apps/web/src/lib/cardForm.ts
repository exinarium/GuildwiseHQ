import {
  CARD_COLUMN_FIELDS,
  type CardType,
  type CompletionAction,
  FIELD_SETS,
  type FieldKind,
  type FieldMeta,
  fieldCatalogue,
  isBuiltinFieldSet,
  isMockField,
  isValidReportPath,
  MockScriptSchema,
  missingForSpecify,
  type PatchCardRequest,
  type Stage,
  type WorkflowDefinition,
  workflowHasDesignStage,
} from '@aom/shared';
import { DEFAULT_PRIORITY } from './priority.ts';

/** Raw form state: everything is a string except the boolean, so inputs stay controlled. */
/**
 * The repository choice "Not sure: let the BA find out" (a project with several repositories): no repository is sent, the
 * card asks for `findRepo`, and the BA works out which repository (or repositories) it touches.
 */
export const FIND_REPO = '__find__';

export interface CardFormValues {
  title: string;
  cardType: string;
  repoId: string;
  completionAction: string;
  docsNeeded: boolean;
  priority: string;
  /** Investigate & design before build: `null` follows the project setting. */
  designNeeded: boolean | null;
  /** Only investigate (no build); implies `designNeeded`. */
  investigationOnly: boolean;
  /** Merge the latest main branch first: '' follows the project setting. */
  mergeMainFirst: '' | 'on' | 'off';
  fields: Record<string, string>;
}

export const emptyForm = (cardType = ''): CardFormValues => ({
  title: '',
  cardType,
  repoId: '',
  completionAction: '',
  docsNeeded: false,
  priority: String(DEFAULT_PRIORITY),
  designNeeded: null,
  investigationOnly: false,
  mergeMainFirst: '',
  fields: {},
});

/** Does the card get an Investigate & design stage? `designDefault` is the project's setting. */
export const effectiveDesign = (
  v: Pick<CardFormValues, 'designNeeded' | 'investigationOnly'>,
  designDefault = false,
): boolean => v.investigationOnly || (v.designNeeded ?? designDefault);

/** Stage a card enters when specified: target of the `CardSpecified` outcome of the initial stage. */
export function specifyTargetStage(def: WorkflowDefinition): Stage | undefined {
  const initial = def.stages.find((s) => s.id === def.initialStage);
  const outcome = initial?.outcomes.find((o) => o.event === 'CardSpecified');
  return def.stages.find((s) => s.id === (outcome?.to ?? '')) ?? def.stages.find((s) => s.kind === 'agent');
}

/** Not editable in the card form (ledger linking arrives with the ledger in M2). */
const HIDDEN_FIELDS = new Set(['linkedLedgerIds', 'reportPath']);

/**
 * Field-set fields (excluding real card columns), in schema order, with their kinds. The mock-runtime fields (Mock
 * script, ...) are listed only in mock mode (`AOM_MOCK_UI` on the server, `features.mockUi` on `/auth/me`).
 */
export function formFieldList(def: WorkflowDefinition, mockUi = false): Array<[string, FieldMeta]> {
  const own = isBuiltinFieldSet(def.fieldSet) ? Object.keys(FIELD_SETS[def.fieldSet].fields) : [];
  const cat = fieldCatalogue(def.fieldSet, def.customFields);
  const keys = [...own, ...def.customFields.map((c) => c.key)];
  return keys
    .filter(
      (k) => !(k in CARD_COLUMN_FIELDS) && !HIDDEN_FIELDS.has(k) && cat[k] && (mockUi || !isMockField(k)),
    )
    .map((k) => [k, cat[k] as FieldMeta]);
}

export const fieldLabel = (def: WorkflowDefinition, key: string): string =>
  fieldCatalogue(def.fieldSet, def.customFields)[key]?.label ?? key;

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** Converts one raw string to the stored value for its kind. Returns `undefined` for blank, `Error` for invalid. */
export function parseFieldValue(kind: FieldKind, raw: string): unknown | undefined | Error {
  const text = raw.trim();
  if (!text) return undefined;
  switch (kind) {
    case 'list':
    case 'url-list':
      return lines(raw);
    case 'number': {
      const n = Number(text);
      return Number.isFinite(n) ? n : new Error('Enter a number');
    }
    case 'boolean':
      return text === 'true';
    case 'json':
      try {
        return JSON.parse(text);
      } catch {
        return new Error('Invalid JSON');
      }
    default:
      return raw;
  }
}

export interface CardFormResult {
  /** Request body pieces. */
  title: string;
  cardType: CardType;
  fields: Record<string, unknown>;
  repoId?: string;
  /** "Not sure which repository": the BA finds it (see `FIND_REPO`). */
  findRepo?: boolean;
  completionAction?: CompletionAction;
  docsNeeded: boolean;
  priority?: number;
  /** Only set when the workflow has an Investigate & design stage and the form says something about it. */
  designNeeded?: boolean;
  investigationOnly?: boolean;
  mergeMainFirst?: boolean;
  /** Field key -> message. Includes parse errors and (for `specify`) missing required fields. */
  errors: Record<string, string>;
}

/**
 * Validates and converts the form. `specify: false` (Save draft) only needs a title and a type; `specify: true` also
 * requires every field of the stage the card enters (shared `requiredMissing`), so the manager sees the missing
 * fields before the server would reject them.
 */
export function buildCardRequest(
  def: WorkflowDefinition,
  v: CardFormValues,
  specify: boolean,
  mockUi = false,
  designDefault = false,
): CardFormResult {
  const errors: Record<string, string> = {};
  const architect = workflowHasDesignStage(def);
  const only = architect && v.investigationOnly;
  const design = architect && effectiveDesign(v, designDefault);
  const cat = fieldCatalogue(def.fieldSet, def.customFields);
  const fields: Record<string, unknown> = {};
  for (const [key, meta] of formFieldList(def, mockUi)) {
    const parsed = parseFieldValue(meta.kind, v.fields[key] ?? '');
    if (parsed instanceof Error) errors[key] = parsed.message;
    else if (parsed !== undefined) {
      if (key === 'mock') {
        const m = MockScriptSchema.safeParse(parsed);
        if (!m.success) {
          errors[key] = 'Mock script must look like {"review":["changes","ok"]}';
          continue;
        }
      }
      fields[key] = parsed;
    }
  }
  const reportPath = (v.fields.reportPath ?? '').trim();
  if (architect && reportPath) {
    if (isValidReportPath(reportPath)) fields.reportPath = reportPath;
    else errors.reportPath = 'Use a relative path without .. (or vault:<path>)';
  }
  if (!v.title.trim()) errors.title = 'Title is required';
  if (!v.cardType) errors.cardType = 'Card type is required';
  const priority = v.priority.trim() ? Number(v.priority) : undefined;
  if (priority !== undefined && (!Number.isInteger(priority) || priority < 1 || priority > 9)) {
    errors.priority = 'Priority is a whole number from 1 to 9';
  }

  if (specify) {
    // Every field of the stages the card goes through, as the server checks it (an investigation-only card needs fewer).
    const missing = missingForSpecify(def, {
      title: v.title,
      cardType: v.cardType,
      // "Not sure" is not a missing repository: the BA finds it.
      repoId: v.repoId === FIND_REPO ? 'find-by-ba' : v.repoId || null,
      // Left empty, the project's "how finished work lands" setting fills it in on the server.
      completionAction: v.completionAction || 'merge',
      docsNeeded: v.docsNeeded,
      designNeeded: design,
      investigationOnly: only,
      priority: priority ?? null,
      fields,
    });
    for (const key of missing) {
      errors[key] ??= `${cat[key]?.label ?? key} is required to specify this card`;
    }
  }

  return {
    title: v.title.trim(),
    cardType: v.cardType as CardType,
    fields,
    ...(v.repoId === FIND_REPO ? { findRepo: true } : v.repoId ? { repoId: v.repoId } : {}),
    ...(v.completionAction ? { completionAction: v.completionAction as CompletionAction } : {}),
    docsNeeded: v.docsNeeded,
    ...(priority !== undefined && !errors.priority ? { priority } : {}),
    ...(architect && (only || v.designNeeded !== null) ? { designNeeded: design } : {}),
    ...(only ? { investigationOnly: true } : {}),
    ...(v.mergeMainFirst ? { mergeMainFirst: v.mergeMainFirst === 'on' } : {}),
    errors,
  };
}

/** A stored field value as the text the form edits (the inverse of `parseFieldValue`). */
export function fieldToText(kind: FieldKind, value: unknown): string {
  if (value === undefined || value === null) return '';
  switch (kind) {
    case 'list':
    case 'url-list':
      return Array.isArray(value) ? value.map(String).join('\n') : String(value);
    case 'json':
      return JSON.stringify(value, null, 2);
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

/** The card as form state, for the Edit dialog. */
export function formValuesFromCard(
  def: WorkflowDefinition,
  card: {
    title: string;
    cardType: string;
    repoId: string | null;
    completionAction: string | null;
    docsNeeded: boolean;
    designNeeded?: boolean | undefined;
    investigationOnly?: boolean | undefined;
    mergeMainFirst?: boolean | null | undefined;
    priority: number;
    fields: Record<string, unknown>;
  },
  mockUi = false,
): CardFormValues {
  const fields: Record<string, string> = {};
  for (const [key, meta] of formFieldList(def, mockUi))
    fields[key] = fieldToText(meta.kind, card.fields[key]);
  fields.reportPath = typeof card.fields.reportPath === 'string' ? card.fields.reportPath : '';
  return {
    title: card.title,
    cardType: card.cardType,
    repoId: card.repoId ?? '',
    completionAction: card.completionAction ?? '',
    docsNeeded: card.docsNeeded,
    priority: String(card.priority),
    designNeeded: card.designNeeded ?? false,
    investigationOnly: card.investigationOnly ?? false,
    mergeMainFirst: card.mergeMainFirst === true ? 'on' : card.mergeMainFirst === false ? 'off' : '',
    fields,
  };
}

/**
 * The `PATCH /api/cards/:id` body for an edit: same validation as the new-card form. A field the user emptied is sent
 * as `null` (the server removes it); a card that is already queued must still have every field of the stage it entered.
 */
export function buildPatchRequest(
  def: WorkflowDefinition,
  v: CardFormValues,
  card: {
    status: string;
    fields: Record<string, unknown>;
    designNeeded?: boolean | undefined;
    investigationOnly?: boolean | undefined;
    mergeMainFirst?: boolean | null | undefined;
  },
  mockUi = false,
  designDefault = false,
): { patch: PatchCardRequest; errors: Record<string, string> } {
  const r = buildCardRequest(def, v, card.status === 'queued', mockUi, designDefault);
  const fields: Record<string, unknown> = { ...r.fields };
  for (const [key] of formFieldList(def, mockUi)) {
    if (!(key in fields) && card.fields[key] !== undefined) fields[key] = null;
  }
  if (workflowHasDesignStage(def) && !('reportPath' in fields) && card.fields.reportPath !== undefined)
    fields.reportPath = null;
  // Flags go in the patch only when they changed: the server locks them once the investigation has happened.
  const architect = workflowHasDesignStage(def);
  const design = architect && effectiveDesign(v, designDefault);
  const only = architect && v.investigationOnly;
  const merge = v.mergeMainFirst === 'on' ? true : v.mergeMainFirst === 'off' ? false : null;
  return {
    errors: r.errors,
    patch: {
      title: r.title,
      docsNeeded: r.docsNeeded,
      completionAction: r.completionAction ?? null,
      repoId: r.repoId ?? null,
      ...(r.priority !== undefined ? { priority: r.priority } : {}),
      ...(architect && design !== (card.designNeeded ?? false) ? { designNeeded: design } : {}),
      ...(architect && only !== (card.investigationOnly ?? false) ? { investigationOnly: only } : {}),
      ...(merge !== (card.mergeMainFirst ?? null) ? { mergeMainFirst: merge } : {}),
      fields,
    },
  };
}
