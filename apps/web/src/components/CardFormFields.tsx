import {
  COMPLETION_ACTION_LABELS,
  CompletionAction,
  ResearchDepth,
  workflowHasDesignStage,
  workflowSupportsInvestigationOnly,
} from '@aom/shared';
import type { CardFormValues } from '../lib/cardForm.ts';
import { effectiveDesign, formFieldList } from '../lib/cardForm.ts';
import { useExpertMode } from '../lib/expert-mode.ts';
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
  template = false,
  designDefault = false,
}: {
  workflow: Workflow;
  values: CardFormValues;
  onChange: (next: CardFormValues) => void;
  errors: Record<string, string>;
  repos: Array<{ id: string; name: string }>;
  mockUi: boolean;
  /** A template for a scheduled card: no repository, completion action or docs flag (they belong to a real card). */
  template?: boolean;
  /** The project's "Investigate & design before build" setting: what an unticked-by-default card follows. */
  designDefault?: boolean;
}) {
  const expert = useExpertMode();
  const v = values;
  const list = formFieldList(workflow, mockUi);
  // Repository and completion action belong to code work; research and feed cards live in the vault.
  const codeCard = !template && workflow.fieldSet !== 'research' && workflow.fieldSet !== 'feed';
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
            {expert && (
              <Select
                label="Completion action"
                value={v.completionAction}
                onChange={(e) => onChange({ ...v, completionAction: e.target.value })}
                error={errors.completionAction}
                hint={
                  v.completionAction
                    ? COMPLETION_ACTION_LABELS[v.completionAction as CompletionAction].description
                    : 'How this card lands. Project default: the setting in the project settings.'
                }
              >
                <option value="">Project default</option>
                {CompletionAction.options.map((a) => (
                  <option key={a} value={a}>
                    {COMPLETION_ACTION_LABELS[a].label}
                  </option>
                ))}
              </Select>
            )}
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
      {codeCard && workflowHasDesignStage(workflow) && (
        <fieldset
          className="flex flex-col gap-2 rounded-card border border-line p-3"
          data-testid="architect-fields"
        >
          <legend className="px-1 text-sm font-semibold text-fg">Investigate &amp; design</legend>
          <div className="flex flex-col gap-0.5">
            <label className="flex items-center gap-2.5 text-base text-fg">
              <input
                type="checkbox"
                className="size-5"
                checked={effectiveDesign(v, designDefault)}
                disabled={v.investigationOnly}
                aria-describedby="design-hint"
                onChange={(e) => onChange({ ...v, designNeeded: e.target.checked })}
              />
              Investigate &amp; design before build
            </label>
            <span id="design-hint" className="pl-[1.875rem] text-sm text-subtle">
              {designDefault
                ? 'On for this project. Untick it for a small, well-located change.'
                : 'An architect reads the code and writes a design first. Off by default; worth it when the approach is uncertain.'}
            </span>
          </div>
          {workflowSupportsInvestigationOnly(workflow) && (
            <div className="flex flex-col gap-0.5">
              <label className="flex items-center gap-2.5 text-base text-fg">
                <input
                  type="checkbox"
                  className="size-5"
                  checked={v.investigationOnly}
                  aria-describedby="investigation-only-hint"
                  onChange={(e) => onChange({ ...v, investigationOnly: e.target.checked })}
                />
                Investigation only
              </label>
              <span id="investigation-only-hint" className="pl-[1.875rem] text-sm text-subtle">
                Nothing is built: the architect's report is the result, and the BA records it. The short field
                set is enough to specify it.
              </span>
            </div>
          )}
          <Select
            label="Merge the latest main branch first"
            value={v.mergeMainFirst}
            onChange={(e) =>
              onChange({ ...v, mergeMainFirst: e.target.value as CardFormValues['mergeMainFirst'] })
            }
            hint="Project default follows the project settings."
          >
            <option value="">Project default</option>
            <option value="on">Yes</option>
            <option value="off">No (for example a hotfix on the working branch)</option>
          </Select>
          {effectiveDesign(v, designDefault) && (
            <TextInput
              label="Report path (optional)"
              value={v.fields.reportPath ?? ''}
              error={errors.reportPath}
              hint="A file or folder in the repository, or vault:<path>. Default: the project's investigation folder."
              onChange={(e) => setField('reportPath', e.target.value)}
            />
          )}
        </fieldset>
      )}
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
