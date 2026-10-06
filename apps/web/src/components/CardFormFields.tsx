import { CompletionAction, ResearchDepth } from '@aom/shared';
import type { CardFormValues } from '../lib/cardForm.ts';
import { formFieldList } from '../lib/cardForm.ts';
import { DEFAULT_PRIORITY } from '../lib/priority.ts';
import { PriorityPicker, Select, TextArea, TextInput } from './ui.tsx';

type Workflow = Parameters<typeof formFieldList>[0];

/**
 * The editable part of a card, shared by the New card page and the Edit dialog: title, repository, completion action,
 * priority, docs needed and the workflow's field set. Mock-runtime fields appear only in mock mode.
 */
export function CardFormFields({
  workflow,
  values,
  onChange,
  errors,
  repos,
  mockUi,
}: {
  workflow: Workflow;
  values: CardFormValues;
  onChange: (next: CardFormValues) => void;
  errors: Record<string, string>;
  repos: Array<{ id: string; name: string }>;
  mockUi: boolean;
}) {
  const v = values;
  const list = formFieldList(workflow, mockUi);
  // Repository and completion action belong to code work; research and feed cards live in the vault.
  const codeCard = workflow.fieldSet !== 'research' && workflow.fieldSet !== 'feed';
  const setField = (k: string, val: string) => onChange({ ...v, fields: { ...v.fields, [k]: val } });
  return (
    <>
      <TextInput
        label="Title"
        value={v.title}
        onChange={(e) => onChange({ ...v, title: e.target.value })}
        error={errors.title}
        maxLength={300}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {codeCard && (
          <>
            <Select
              label="Repository"
              value={v.repoId}
              onChange={(e) => onChange({ ...v, repoId: e.target.value })}
              error={errors.repoId}
            >
              <option value="">None</option>
              {repos.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
            <Select
              label="Completion action"
              value={v.completionAction}
              onChange={(e) => onChange({ ...v, completionAction: e.target.value })}
              error={errors.completionAction}
            >
              <option value="">None</option>
              {CompletionAction.options.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </Select>
          </>
        )}
        <PriorityPicker
          value={v.priority.trim() ? Number(v.priority) : DEFAULT_PRIORITY}
          onChange={(n) => onChange({ ...v, priority: String(n ?? DEFAULT_PRIORITY) })}
          hint="Urgent cards are picked up first."
        />
        {codeCard && (
          <label className="flex min-h-9 items-center gap-2.5 self-end pb-1 text-base text-fg">
            <input
              type="checkbox"
              checked={v.docsNeeded}
              onChange={(e) => onChange({ ...v, docsNeeded: e.target.checked })}
              className="size-5"
            />
            Docs needed
          </label>
        )}
      </div>
      {list.map(([k, meta]) => {
        const common = {
          label: meta.label,
          value: v.fields[k] ?? '',
          error: errors[k],
        };
        if (meta.kind === 'text') {
          return <TextInput key={k} {...common} onChange={(e) => setField(k, e.target.value)} />;
        }
        if (meta.kind === 'number') {
          return (
            <TextInput
              key={k}
              {...common}
              inputMode="numeric"
              onChange={(e) => setField(k, e.target.value)}
            />
          );
        }
        if (meta.kind === 'enum' && k === 'depth') {
          return (
            <Select key={k} {...common} onChange={(e) => setField(k, e.target.value)}>
              <option value="">Choose...</option>
              {ResearchDepth.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </Select>
          );
        }
        const hint =
          meta.kind === 'list' || meta.kind === 'url-list'
            ? 'One item per line'
            : meta.kind === 'json'
              ? 'JSON, optional'
              : undefined;
        return (
          <TextArea
            key={k}
            {...common}
            {...(hint ? { hint } : {})}
            rows={meta.kind === 'markdown' || meta.kind === 'list' ? 4 : 3}
            className={meta.kind === 'json' ? 'font-mono' : undefined}
            onChange={(e) => setField(k, e.target.value)}
          />
        );
      })}
    </>
  );
}
