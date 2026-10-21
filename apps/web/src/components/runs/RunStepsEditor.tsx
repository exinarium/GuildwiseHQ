import {
  describeService,
  describeStep,
  itemLabel,
  RUN_TEMPLATES,
  type RunPlanItem,
  type RunService,
  type RunSetupStep,
  type RunTemplateId,
  templateInfo,
} from '@aom/shared';
import {
  ArrowDown,
  ArrowUp,
  Box,
  Check,
  Container,
  Database,
  Globe,
  Hammer,
  type LucideIcon,
  Package,
  Pencil,
  Plus,
  Terminal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Dialog, Disclosure } from '../ui.tsx';
import { moveEntry, newKey, type PlanEntry } from './plan-entries.ts';
import { type RunFormContext, RunStepForm } from './RunStepForm.tsx';

const ICONS: Record<string, LucideIcon> = {
  install_packages: Package,
  build: Hammer,
  prepare_db: Database,
  web_app: Globe,
  docker_service: Container,
  compose_stack: Box,
  custom_step: Terminal,
  custom_service: Terminal,
};

const FORM_ID = 'run-step-form';

/**
 * The guided editor of the run steps (docs/design/deploy-run-ux-design.md section 3.1 R1): "Before starting" (steps) and
 * "Parts of the app" (services) as cards, each editable through the questions of its template. It edits a list of entries
 * that becomes the same run plan the runner replays; the developer view of each card shows the real command.
 */
export function RunStepsEditor({
  entries,
  onChange,
  repos,
  canEdit = true,
  editingKey,
  onEditingKeyChange,
  bannersFor,
  review = false,
}: {
  entries: PlanEntry[];
  onChange: (next: PlanEntry[]) => void;
  repos: Array<{ repoId: string; name: string }>;
  canEdit?: boolean;
  /** Controlled editing (a scan review opens a card from its questions). */
  editingKey?: string | null;
  onEditingKeyChange?: (key: string | null) => void;
  /** What DevOps asked about a card: shown above its form. */
  bannersFor?: (key: string) => string[];
  review?: boolean;
}) {
  const [localEditing, setLocalEditing] = useState<string | null>(null);
  const editing = editingKey !== undefined ? editingKey : localEditing;
  const setEditing = (k: string | null) => (onEditingKeyChange ? onEditingKeyChange(k) : setLocalEditing(k));
  const [adding, setAdding] = useState<null | { kind: 'step' | 'service'; template?: RunTemplateId }>(null);

  const ctx: RunFormContext = {
    repos,
    serviceNames: entries.filter((e) => e.kind === 'service').map((e) => e.item.name),
    folders: [...new Set(entries.map((e) => e.item.cwd))],
  };
  const steps = entries.filter((e) => e.kind === 'step');
  const parts = entries.filter((e) => e.kind === 'service');
  const current = entries.find((e) => e.key === editing);

  const replace = (key: string, item: RunPlanItem) =>
    onChange(
      entries.map((e): PlanEntry => {
        if (e.key !== key) return e;
        const review = e.review ? { ...e.review, confirmed: true } : undefined;
        return item.kind === 'step'
          ? { key, kind: 'step', item: item.item, ...(review ? { review } : {}) }
          : { key, kind: 'service', item: item.item, ...(review ? { review } : {}) };
      }),
    );
  const confirm = (key: string) =>
    onChange(
      entries.map((e) =>
        e.key === key && e.review ? { ...e, review: { ...e.review, confirmed: true } } : e,
      ),
    );
  const remove = (key: string) => {
    // Parts that waited for the removed one no longer wait for it.
    const gone = entries.find((e) => e.key === key);
    const next = entries
      .filter((e) => e.key !== key)
      .map((e) =>
        gone?.kind === 'service' && e.kind === 'service' && e.item.after.includes(gone.item.name)
          ? { ...e, item: { ...e.item, after: e.item.after.filter((a) => a !== gone.item.name) } }
          : e,
      );
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-6" data-testid="run-steps-editor">
      <Section
        title="Before starting"
        hint="Things that run once before the app starts, in this order."
        empty="Nothing runs before the app starts."
        canEdit={canEdit}
        addLabel="Add a step"
        onAdd={() => setAdding({ kind: 'step' })}
        testId="run-steps-before"
      >
        {steps.map((e, i) => (
          <EntryCard
            key={e.key}
            entry={e}
            first={i === 0}
            last={i === steps.length - 1}
            canEdit={canEdit}
            review={review}
            onEdit={() => setEditing(e.key)}
            onRemove={() => remove(e.key)}
            onMove={(d) => onChange(moveEntry(entries, e.key, d))}
            onConfirm={() => confirm(e.key)}
          />
        ))}
      </Section>
      <Section
        title="Parts of the app"
        hint="Things that keep running: the website, a database. Guildwise starts them in order and waits until each is ready."
        empty="No part yet. Add the part that runs the app itself."
        canEdit={canEdit}
        addLabel="Add a part"
        onAdd={() => setAdding({ kind: 'service' })}
        testId="run-steps-parts"
      >
        {parts.map((e, i) => (
          <EntryCard
            key={e.key}
            entry={e}
            first={i === 0}
            last={i === parts.length - 1}
            canEdit={canEdit}
            review={review}
            onEdit={() => setEditing(e.key)}
            onRemove={() => remove(e.key)}
            onMove={(d) => onChange(moveEntry(entries, e.key, d))}
            onConfirm={() => confirm(e.key)}
          />
        ))}
      </Section>

      {current && (
        <Dialog
          open
          onOpenChange={(o) => !o && setEditing(null)}
          title={`Edit: ${itemLabel(current.item)}`}
          size="lg"
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" type="submit" form={FORM_ID} data-testid="step-save">
                Save
              </Button>
            </>
          }
        >
          <RunStepForm
            key={current.key}
            formId={FORM_ID}
            template={
              (current.item.template as RunTemplateId | undefined) ??
              (current.kind === 'step' ? 'custom_step' : 'custom_service')
            }
            initial={{ kind: current.kind, item: current.item } as RunPlanItem}
            ctx={ctx}
            {...(bannersFor ? { banner: bannersFor(current.key) } : {})}
            onSubmit={(item) => {
              replace(current.key, item);
              setEditing(null);
            }}
          />
        </Dialog>
      )}

      {adding && (
        <Dialog
          open
          onOpenChange={(o) => !o && setAdding(null)}
          title={
            adding.template
              ? (templateInfo(adding.template)?.title ?? 'Add')
              : adding.kind === 'step'
                ? 'Add a step'
                : 'Add a part'
          }
          description={adding.template ? undefined : 'What should Guildwise do?'}
          size="lg"
          footer={
            adding.template ? (
              <>
                <Button onClick={() => setAdding({ kind: adding.kind })}>Back</Button>
                <Button variant="primary" type="submit" form={FORM_ID} data-testid="step-add">
                  Add
                </Button>
              </>
            ) : (
              <Button onClick={() => setAdding(null)}>Cancel</Button>
            )
          }
        >
          {adding.template ? (
            <RunStepForm
              key={adding.template}
              formId={FORM_ID}
              template={adding.template}
              ctx={ctx}
              onSubmit={(item) => {
                const entry: PlanEntry =
                  item.kind === 'step'
                    ? { key: newKey(), kind: 'step', item: item.item }
                    : { key: newKey(), kind: 'service', item: item.item };
                // new steps go after the last step; new parts after the last part
                const lastOfKind = entries.map((e) => e.kind).lastIndexOf(item.kind);
                const idx = item.kind === 'step' ? lastOfKind + 1 : entries.length;
                onChange([...entries.slice(0, idx), entry, ...entries.slice(idx)]);
                setAdding(null);
              }}
            />
          ) : (
            <TemplatePicker
              kind={adding.kind}
              onPick={(template) => setAdding({ kind: adding.kind, template })}
            />
          )}
        </Dialog>
      )}
    </div>
  );
}

function TemplatePicker({ kind, onPick }: { kind: 'step' | 'service'; onPick: (t: RunTemplateId) => void }) {
  const all = RUN_TEMPLATES.filter((t) => t.kind === kind);
  const row = (t: (typeof all)[number]) => {
    const Icon = ICONS[t.id] ?? Terminal;
    return (
      <li key={t.id}>
        <button
          type="button"
          onClick={() => onPick(t.id)}
          data-testid={`template-${t.id}`}
          className="flex min-h-14 w-full items-start gap-3 rounded-control border border-line bg-surface p-3 text-left hover:bg-sunken"
        >
          <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted" />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-fg">{t.title}</span>
            <span className="block text-xs text-muted">{t.blurb}</span>
          </span>
        </button>
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-col gap-2" data-testid="template-picker">
        {all.filter((t) => !t.advanced).map(row)}
      </ul>
      <Disclosure summary="More">
        <ul className="flex flex-col gap-2">{all.filter((t) => t.advanced).map(row)}</ul>
      </Disclosure>
    </div>
  );
}

function Section({
  title,
  hint,
  empty,
  canEdit,
  addLabel,
  onAdd,
  children,
  testId,
}: {
  title: string;
  hint: string;
  empty: string;
  canEdit: boolean;
  addLabel: string;
  onAdd: () => void;
  children: React.ReactNode;
  testId: string;
}) {
  const kids = Array.isArray(children) ? children : [children];
  const none = kids.flat().filter(Boolean).length === 0;
  return (
    <section className="flex flex-col gap-2" data-testid={testId} aria-label={title}>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">{title}</h3>
          <p className="text-xs text-subtle">{hint}</p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={onAdd}>
            <Plus aria-hidden="true" className="size-4" />
            {addLabel}
          </Button>
        )}
      </div>
      {none ? (
        <p className="rounded-control border border-dashed border-line p-3 text-sm text-muted">{empty}</p>
      ) : (
        <ol className="flex flex-col gap-2">{children}</ol>
      )}
    </section>
  );
}

const CONFIDENCE = {
  found: { tone: 'success', text: 'Found' },
  guessed: { tone: 'warning', text: 'Guessed, please check' },
  unknown: { tone: 'danger', text: 'Needs your answer' },
} as const;

function EntryCard({
  entry,
  first,
  last,
  canEdit,
  review,
  onEdit,
  onRemove,
  onMove,
  onConfirm,
}: {
  entry: PlanEntry;
  first: boolean;
  last: boolean;
  canEdit: boolean;
  review: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
  onConfirm: () => void;
}) {
  const item = entry.item as RunSetupStep & RunService;
  const Icon = ICONS[item.template ?? (entry.kind === 'step' ? 'custom_step' : 'custom_service')] ?? Terminal;
  const r = entry.review;
  const label = itemLabel(item);
  const cmd = entry.kind === 'step' ? describeStep(entry.item) : describeService(entry.item);
  return (
    <li
      className="flex flex-col gap-2 rounded-control border border-line bg-surface p-3"
      data-testid={`run-entry-${label}`}
    >
      <div className="flex items-start gap-3">
        <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg [overflow-wrap:anywhere]">{label}</span>
            {item.docker && <Badge tone="info">Docker</Badge>}
            {review && r && (
              <Badge
                tone={r.confirmed && r.confidence !== 'found' ? 'success' : CONFIDENCE[r.confidence].tone}
                data-testid="entry-confidence"
              >
                {r.confirmed && r.confidence !== 'found' ? 'Checked' : CONFIDENCE[r.confidence].text}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted [overflow-wrap:anywhere]">{cmd}</p>
          {review && r && r.evidence.length > 0 && (
            <p className="text-xs text-subtle">
              from{' '}
              {r.evidence
                .map((e) => (e.file ? `${e.file}${e.line ? `:${e.line}` : ''}` : e.probe))
                .filter(Boolean)
                .join(', ')}
            </p>
          )}
          {review &&
            r?.notes.map((n) => (
              <p key={n} className="text-xs text-subtle">
                {n}
              </p>
            ))}
        </div>
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center gap-1">
          <Button size="sm" onClick={onEdit} aria-label={`Edit ${label}`}>
            <Pencil aria-hidden="true" className="size-4" />
            Edit
          </Button>
          {review && r && r.confidence === 'guessed' && !r.confirmed && (
            <Button size="sm" onClick={onConfirm} aria-label={`${label} looks right`}>
              <Check aria-hidden="true" className="size-4" />
              Looks right
            </Button>
          )}
          <span className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            disabled={first}
            onClick={() => onMove(-1)}
            aria-label={`Move ${label} up`}
          >
            <ArrowUp aria-hidden="true" className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={last}
            onClick={() => onMove(1)}
            aria-label={`Move ${label} down`}
          >
            <ArrowDown aria-hidden="true" className="size-4" />
          </Button>
          <Button size="sm" variant="danger-ghost" onClick={onRemove} aria-label={`Remove ${label}`}>
            <Trash2 aria-hidden="true" className="size-4" />
          </Button>
        </div>
      )}
    </li>
  );
}
