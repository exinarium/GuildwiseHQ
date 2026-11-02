import {
  FIELD_TYPE_META,
  FORM_LIMITS,
  FORM_TEMPLATE_KEYS,
  type FormDefinitionIssue,
  type FormDestination,
  type FormField,
} from '@aom/shared';
import { useState } from 'react';
import type { StorageConnectionOption } from '../../api/queries/forms.ts';
import { FILE_TYPE_GROUPS, normaliseFileType } from '../../lib/formBuilder.ts';
import { cx } from '../ui/cx.ts';
import { Select, TextArea, TextInput } from '../ui.tsx';

/** The first issue whose path ends with `.<sub>`. */
export const issueFor = (issues: readonly FormDefinitionIssue[], sub: string): string | undefined =>
  issues.find((i) => i.path === sub || i.path.endsWith(`.${sub}`))?.message;

const num = (s: string): number | undefined => {
  if (s.trim() === '') return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** Drops a key whose value is undefined, so the saved definition has no empty properties. */
function patched(field: FormField, patch: Record<string, unknown>): FormField {
  const next: Record<string, unknown> = { ...field, ...patch };
  for (const k of Object.keys(patch)) if (next[k] === undefined) delete next[k];
  return next as FormField;
}

/** Destination (connection, folder, file name) of an upload or of the text answers. */
export function DestinationInputs({
  idPrefix,
  value,
  onChange,
  connections,
  issues,
  issuePrefix,
  disabled,
}: {
  idPrefix: string;
  value: FormDestination;
  onChange: (d: FormDestination) => void;
  connections: readonly StorageConnectionOption[];
  issues: readonly FormDefinitionIssue[];
  issuePrefix: string;
  disabled?: boolean;
}) {
  const keys = FORM_TEMPLATE_KEYS.map((k) => `{${k}}`).join(' ');
  return (
    <div className="flex flex-col gap-3">
      <Select
        id={`${idPrefix}-connection`}
        label="Destination connection"
        disabled={disabled}
        value={value.connectionId ?? ''}
        onChange={(e) => onChange({ ...value, connectionId: e.target.value || null })}
      >
        <option value="">Not set</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <TextInput
        id={`${idPrefix}-folder`}
        label="Folder"
        disabled={disabled}
        value={value.folder}
        maxLength={FORM_LIMITS.label * 2}
        hint={`Keys you can use: ${keys}`}
        error={issueFor(issues, `${issuePrefix}.folder`)}
        onChange={(e) => onChange({ ...value, folder: e.target.value })}
      />
      <TextInput
        id={`${idPrefix}-name`}
        label="File name"
        disabled={disabled}
        value={value.name}
        maxLength={FORM_LIMITS.label}
        hint={`Keys you can use: ${keys}`}
        error={issueFor(issues, `${issuePrefix}.name`)}
        onChange={(e) => onChange({ ...value, name: e.target.value })}
      />
    </div>
  );
}

/** The inputs for the selected field, chosen by `FIELD_TYPE_META[type].properties`. */
export function FieldProperties({
  field,
  onChange,
  connections,
  issues,
  disabled,
}: {
  field: FormField;
  onChange: (f: FormField) => void;
  connections: readonly StorageConnectionOption[];
  issues: readonly FormDefinitionIssue[];
  disabled?: boolean;
}) {
  const props = FIELD_TYPE_META[field.type].properties;
  const has = (p: (typeof props)[number]) => props.includes(p);
  const set = (patch: Record<string, unknown>) => onChange(patched(field, patch));
  const id = `prop-${field.id}`;
  const [extra, setExtra] = useState('');
  const [optionsText, setOptionsText] = useState<string | null>(null);
  const [sizeText, setSizeText] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4" data-testid="field-properties">
      <h2 className="text-sm font-semibold text-fg">{FIELD_TYPE_META[field.type].label} field</h2>
      <TextInput
        id={`${id}-label`}
        label="Label"
        disabled={disabled}
        value={field.label}
        maxLength={FORM_LIMITS.label}
        error={field.label.trim() === '' ? 'Enter a label.' : issueFor(issues, 'label')}
        onChange={(e) => set({ label: e.target.value })}
      />
      <label className="flex min-h-9 items-center gap-2 text-sm text-fg [@media(pointer:coarse)]:min-h-11">
        <input
          type="checkbox"
          disabled={disabled}
          checked={field.required}
          onChange={(e) => set({ required: e.target.checked })}
        />
        Required
      </label>
      {has('placeholder') && (
        <TextInput
          id={`${id}-placeholder`}
          label="Placeholder"
          disabled={disabled}
          value={(field as { placeholder?: string }).placeholder ?? ''}
          maxLength={FORM_LIMITS.placeholder}
          onChange={(e) => set({ placeholder: e.target.value || undefined })}
        />
      )}
      {has('helpText') && (
        <TextInput
          id={`${id}-help`}
          label="Help text"
          disabled={disabled}
          value={field.helpText ?? ''}
          maxLength={FORM_LIMITS.helpText}
          onChange={(e) => set({ helpText: e.target.value || undefined })}
        />
      )}
      {(field.type === 'short_text' || field.type === 'long_text') && (
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            id={`${id}-minlen`}
            label="Minimum length"
            type="number"
            min={0}
            disabled={disabled}
            value={field.minLength ?? ''}
            error={issueFor(issues, 'minLength')}
            onChange={(e) => set({ minLength: num(e.target.value) })}
          />
          <TextInput
            id={`${id}-maxlen`}
            label="Maximum length"
            type="number"
            min={1}
            disabled={disabled}
            value={field.maxLength ?? ''}
            error={issueFor(issues, 'maxLength')}
            onChange={(e) => set({ maxLength: num(e.target.value) })}
          />
        </div>
      )}
      {field.type === 'number' && (
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            id={`${id}-min`}
            label="Minimum value"
            type="number"
            step="any"
            disabled={disabled}
            value={field.min ?? ''}
            error={issueFor(issues, 'min')}
            onChange={(e) => set({ min: num(e.target.value) })}
          />
          <TextInput
            id={`${id}-max`}
            label="Maximum value"
            type="number"
            step="any"
            disabled={disabled}
            value={field.max ?? ''}
            error={issueFor(issues, 'max')}
            onChange={(e) => set({ max: num(e.target.value) })}
          />
        </div>
      )}
      {field.type === 'date' && (
        <div className="grid grid-cols-2 gap-3">
          <TextInput
            id={`${id}-dmin`}
            label="Earliest date"
            type="date"
            disabled={disabled}
            value={field.min ?? ''}
            error={issueFor(issues, 'min')}
            onChange={(e) => set({ min: e.target.value || undefined })}
          />
          <TextInput
            id={`${id}-dmax`}
            label="Latest date"
            type="date"
            disabled={disabled}
            value={field.max ?? ''}
            error={issueFor(issues, 'max')}
            onChange={(e) => set({ max: e.target.value || undefined })}
          />
        </div>
      )}
      {(field.type === 'dropdown' || field.type === 'radio' || field.type === 'checkbox') && (
        <TextArea
          id={`${id}-options`}
          label="Options"
          rows={5}
          disabled={disabled}
          hint="One option per line."
          value={optionsText ?? field.options.join('\n')}
          error={issueFor(issues, 'options')}
          onChange={(e) => {
            setOptionsText(e.target.value);
            set({
              options: e.target.value
                .split('\n')
                .map((o) => o.trim())
                .filter(Boolean),
            });
          }}
          onBlur={() => setOptionsText(null)}
        />
      )}
      {field.type === 'file' && (
        <>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="text-sm font-medium text-fg">Allowed file types</legend>
            {FILE_TYPE_GROUPS.map((g) => {
              const on = g.types.every((t) => field.allowedTypes.includes(t));
              return (
                <label
                  key={g.label}
                  className="flex min-h-9 items-center gap-2 text-sm text-fg [@media(pointer:coarse)]:min-h-11"
                >
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={on}
                    onChange={(e) => {
                      const rest = field.allowedTypes.filter((t) => !g.types.includes(t));
                      set({ allowedTypes: e.target.checked ? [...rest, ...g.types] : rest });
                    }}
                  />
                  {g.label}
                </label>
              );
            })}
            <p className="text-xs text-subtle" data-testid="allowed-types">
              {field.allowedTypes.join(', ') || 'None chosen'}
            </p>
            <TextInput
              id={`${id}-extra`}
              label="Other extension"
              disabled={disabled}
              value={extra}
              placeholder="for example csv"
              hint="Press Enter to add."
              error={issueFor(issues, 'allowedTypes')}
              onChange={(e) => setExtra(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const t = normaliseFileType(extra);
                if (t && !field.allowedTypes.includes(t)) set({ allowedTypes: [...field.allowedTypes, t] });
                setExtra('');
              }}
            />
          </fieldset>
          <TextInput
            id={`${id}-size`}
            label="Size limit (MB)"
            type="number"
            min={1}
            max={FORM_LIMITS.fileMaxBytes / (1024 * 1024)}
            disabled={disabled}
            value={sizeText ?? Math.round((field.maxSizeBytes / (1024 * 1024)) * 100) / 100}
            error={issueFor(issues, 'maxSizeBytes')}
            onBlur={() => setSizeText(null)}
            onChange={(e) => {
              setSizeText(e.target.value);
              const mb = num(e.target.value);
              if (mb !== undefined) set({ maxSizeBytes: Math.round(mb * 1024 * 1024) });
            }}
          />
          <DestinationInputs
            idPrefix={`${id}-dest`}
            value={field.destination}
            connections={connections}
            issues={issues}
            issuePrefix="destination"
            disabled={disabled}
            onChange={(d) => set({ destination: d })}
          />
        </>
      )}
      {issues.length > 0 && (
        <ul className={cx('list-disc pl-5 text-sm text-danger')} role="alert">
          {issues
            .filter(
              (i) =>
                !/\.(label|minLength|maxLength|min|max|options|allowedTypes|maxSizeBytes|folder|name)$/.test(
                  i.path,
                ),
            )
            .map((i) => (
              <li key={`${i.path}-${i.message}`}>{i.message}</li>
            ))}
        </ul>
      )}
    </div>
  );
}
