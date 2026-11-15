import {
  ENFORCED_BY_EXPLAIN,
  type EnforcedBy,
  type IndustryBundleInstallResult,
  type IndustryBundlePreview,
  type IndustryBundleRemoveResult,
  type IndustryBundleSummary,
} from '@aom/shared';
import { useState } from 'react';
import {
  useIndustryBundlePreview,
  useIndustryBundles,
  useInstallIndustryBundle,
  useRemoveIndustryBundle,
} from '../api/queries/industryBundles.ts';
import { useProjects } from '../api/queries/projects.ts';
import { useCanManageOrg } from '../lib/orgRole.ts';
import { plural, statusLine } from '../lib/rulePackStatus.ts';
import { type OrgTermsApi, useOrgTerms } from '../lib/terms.ts';
import { EnforcedByBadge } from './EnforcedByBadge.tsx';
import {
  Badge,
  Button,
  Callout,
  ConfirmDialog,
  Dialog,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  Select,
  useToast,
} from './ui.tsx';

type Result =
  | { kind: 'install'; r: IndustryBundleInstallResult; preview: IndustryBundlePreview }
  | { kind: 'uninstall'; r: IndustryBundleRemoveResult };

interface GroupItem {
  key: string;
  title: string;
  status: string;
  line: string | null;
  enforcedBy?: EnforcedBy;
}
interface Group {
  kind: string;
  label: string;
  items: GroupItem[];
}

/** Turns the server preview into the groups the screen lists. Every array is guarded: a schema mismatch only warns. */
function groupsOf(p: IndustryBundlePreview, t: OrgTermsApi): Group[] {
  const doc = (status: string) =>
    status === 'present'
      ? 'A document with this title already exists, left as it is'
      : 'Will be added to Documents';
  const groups: Group[] = [
    {
      kind: 'rule',
      label: t.StandingOrders,
      items: (p.rulePack?.rules ?? []).map((r) => ({
        key: r.id,
        title: r.title,
        status: r.status,
        line: statusLine(r),
        enforcedBy: r.enforcedBy,
      })),
    },
    {
      kind: 'playbook',
      label: 'Playbooks',
      items: (p.playbooks ?? []).map((x) => ({
        key: x.key,
        title: x.name,
        status: x.status,
        line: x.status === 'present' ? 'Already set up, left as it is' : 'Will be added, switched off',
      })),
    },
    {
      kind: 'knowledge_template',
      label: 'Knowledge templates',
      items: (p.knowledgeTemplates ?? []).map((x) => ({
        key: x.id,
        title: x.title,
        status: x.status,
        line: doc(x.status),
      })),
    },
    {
      kind: 'sample_data',
      label: 'Sample data',
      items: (p.sampleData ?? []).map((x) => ({
        key: x.id,
        title: x.title,
        status: x.status,
        line: doc(x.status),
      })),
    },
    {
      kind: 'journey_template',
      label: 'Journey templates',
      items: (p.journeyTemplates ?? []).map((x) => ({
        key: x.id,
        title: x.name,
        status: 'available',
        line: 'Always available in the Journeys gallery',
      })),
    },
  ];
  return groups.filter((g) => g.items.length > 0);
}

function contentsLine(c: IndustryBundleSummary['counts'], t: OrgTermsApi): string {
  const parts: Array<[number, string, string]> = [
    [c.rules, 'rule', 'rules'],
    [c.playbooks, 'playbook', 'playbooks'],
    [c.knowledgeTemplates, 'knowledge template', 'knowledge templates'],
    [c.sampleData, 'sample document', 'sample documents'],
    [c.journeyTemplates, 'journey template', 'journey templates'],
  ];
  return t.reword(
    parts
      .filter(([n]) => n > 0)
      .map(([n, one, many]) => plural(n, one, many))
      .join(' · '),
  );
}

function BundleList({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useOrgTerms();
  const bundles = useIndustryBundles();
  const list = bundles.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      {bundles.isPending && <ListSkeleton label="Loading the bundles" />}
      <ErrorBox error={bundles.error} onRetry={() => bundles.refetch()} />
      {bundles.data && list.length === 0 && <EmptyState title="No industry bundles yet" />}
      <ul className="flex flex-col gap-2">
        {list.map((b) => (
          <li key={b.id} data-testid="industry-bundle">
            <button
              type="button"
              onClick={() => onOpen(b.id)}
              className="flex w-full flex-col gap-1 rounded-control border border-line px-3 py-3 text-left hover:bg-sunken [@media(pointer:coarse)]:min-h-11"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-fg">{b.name}</span>
                {b.installed && <Badge tone="green">Installed</Badge>}
              </span>
              <span className="text-sm text-muted">{b.description}</span>
              <span className="text-xs text-subtle" data-testid="bundle-contents">
                {contentsLine(b.counts, t)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const KIND_WORD = { rule: 'rule', playbook: 'playbook', document: 'document' } as const;
const REASON = { edited: 'you edited it', present_before_install: 'it was there before the bundle' } as const;

function BundleResult({ result }: { result: Result }) {
  if (result.kind === 'uninstall') {
    const { removed, kept, gone } = result.r;
    const removedCount =
      (removed?.ruleEntries ?? []).length +
      (removed?.schedules ?? []).length +
      (removed?.documents ?? []).length;
    const keptList = kept ?? [];
    const goneCount = (gone ?? []).length;
    return (
      <Callout tone="success" role="status" data-testid="bundle-result" title="Bundle uninstalled">
        <p>{`Removed ${plural(removedCount, 'item', 'items')}.`}</p>
        {keptList.length === 0 ? (
          <p>Nothing was kept.</p>
        ) : (
          <>
            <p>Kept, because your organization created or edited them:</p>
            <ul data-testid="bundle-kept" className="list-disc pl-5">
              {keptList.map((k) => (
                <li key={`${k.kind}-${k.id}`}>
                  {k.title} ({KIND_WORD[k.kind]}): {REASON[k.reason]}
                </li>
              ))}
            </ul>
          </>
        )}
        {goneCount > 0 && <p>{`${plural(goneCount, 'item was', 'items were')} already removed.`}</p>}
      </Callout>
    );
  }
  const { r, preview } = result;
  if (r.status === 'already_installed')
    return (
      <Callout tone="info" role="status" data-testid="bundle-result" title="Already installed">
        Nothing changed.
      </Callout>
    );
  const docs = r.documents?.added ?? [];
  const added = [
    plural(r.rulePack?.added.length ?? 0, 'rule', 'rules'),
    `${plural((r.playbooks?.added ?? []).length, 'playbook', 'playbooks')} (switched off: turn them on in Schedules)`,
    plural(docs.filter((d) => d.kind === 'template').length, 'knowledge template', 'knowledge templates'),
    plural(docs.filter((d) => d.kind === 'sample').length, 'sample document', 'sample documents'),
  ];
  const presentCount = (r.playbooks?.present ?? []).length + (r.documents?.present ?? []).length;
  const skipped = r.rulePack?.skipped ?? [];
  const names = (preview.journeyTemplates ?? []).map((j) => j.name);
  return (
    <Callout tone="success" role="status" data-testid="bundle-result" title="Bundle installed">
      <p>{`Added ${added.join(', ')}.`}</p>
      {r.rulePack === null && <p>The rules were already installed, so they were left as they are.</p>}
      {skipped.length > 0 && (
        <p>
          {`${plural(skipped.length, 'rule was', 'rules were')} skipped because your own rules cover them: ${skipped
            .map((s) => s.existingTitle)
            .join(', ')}.`}
        </p>
      )}
      {presentCount > 0 && (
        <p>{`${plural(presentCount, 'item was', 'items were')} already there and left as they are.`}</p>
      )}
      {names.length > 0 && <p>{`Journey templates in the Journeys gallery: ${names.join(', ')}.`}</p>}
    </Callout>
  );
}

function BundlePreview({
  bundleId,
  result,
  setResult,
  onBack,
}: {
  bundleId: string;
  result: Result | null;
  setResult: (r: Result | null) => void;
  onBack: () => void;
}) {
  const t = useOrgTerms();
  const toast = useToast();
  const canManage = useCanManageOrg();
  const [projectId, setProjectId] = useState('');
  const [confirm, setConfirm] = useState(false);
  const preview = useIndustryBundlePreview(bundleId, projectId || undefined);
  const projects = (useProjects().data ?? []).filter((p) => p.status === 'active');
  const install = useInstallIndustryBundle();
  const remove = useRemoveIndustryBundle();
  const p = preview.data;
  const blockers = p?.blockers ?? [];
  const groups = p ? groupsOf(p, t) : [];
  const rules = p?.rulePack?.rules ?? [];
  const flagged = rules.filter((r) => r.status === 'may_conflict' || r.status === 'covered').length;
  const err = install.error ?? remove.error;
  return (
    <div data-testid="industry-bundle-preview" className="flex flex-col gap-3">
      <div>
        <Button size="sm" variant="ghost" onClick={onBack}>
          All bundles
        </Button>
      </div>
      {preview.isPending && <ListSkeleton label="Loading the bundle" />}
      <ErrorBox error={preview.error} onRetry={() => preview.refetch()} />
      {result && <BundleResult result={result} />}
      {p && (
        <>
          <div>
            <h3 className="flex flex-wrap items-center gap-2 text-lg font-semibold text-fg">
              {p.name}
              {p.installed && <Badge tone="green">Installed</Badge>}
            </h3>
            <p className="text-sm text-muted">{p.description}</p>
          </div>
          {flagged > 0 && (
            <Callout tone="warning" data-testid="bundle-flags">
              {t.reword(
                `${plural(flagged, 'rule may', 'rules may')} contradict or repeat your own rules. They are marked below.`,
              )}
            </Callout>
          )}
          {rules.length > 0 && (
            <p className="text-sm text-subtle" data-testid="enforced-by-legend">
              <strong>Guildwise (server check)</strong>: {ENFORCED_BY_EXPLAIN.server_check}{' '}
              <strong>Agent instruction</strong>: {ENFORCED_BY_EXPLAIN.agent_instruction}
            </p>
          )}
          {groups.map((g) => (
            <section key={g.kind} aria-label={g.label} className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold text-subtle uppercase">{g.label}</h4>
              <ul className="flex flex-col divide-y divide-line rounded-control border border-line">
                {g.items.map((i) => (
                  <li
                    key={i.key}
                    data-testid="bundle-item"
                    data-kind={g.kind}
                    className="flex flex-col gap-1 px-3 py-3 [@media(pointer:coarse)]:min-h-11"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg">{i.title}</span>
                      {i.enforcedBy && <EnforcedByBadge value={i.enforcedBy} />}
                    </div>
                    {i.line && (
                      <p
                        className="text-xs text-subtle"
                        data-testid="bundle-item-status"
                        data-status={i.status}
                      >
                        {i.line}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {canManage && !p.installed && blockers.some((b) => b.code === 'project_required') && (
            <Select
              label="Project"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              hint="Playbook cards are made in this project"
              className="min-h-11"
            >
              <option value="">Choose a project</option>
              {projects.map((pr) => (
                <option key={pr.id} value={pr.id}>
                  {pr.name}
                </option>
              ))}
            </Select>
          )}
          {canManage &&
            !p.installed &&
            blockers
              .filter((b) => b.code === 'no_project')
              .map((b) => (
                <Callout key={b.code} tone="warning">
                  {b.message}
                </Callout>
              ))}
          <ErrorBox error={err} />
          {canManage && (
            <div className="flex flex-wrap gap-2">
              {!p.installed && (
                <Button
                  variant="primary"
                  loading={install.isPending}
                  disabled={blockers.length > 0}
                  onClick={() => {
                    const snapshot = p;
                    install.mutate(
                      { id: p.id, ...(projectId ? { projectId } : {}) },
                      {
                        onSuccess: (r) => {
                          setResult({ kind: 'install', r, preview: snapshot });
                          toast.success(
                            r.status === 'already_installed' ? 'Already installed' : `${p.name} installed`,
                          );
                        },
                      },
                    );
                  }}
                >
                  Install bundle
                </Button>
              )}
              {p.installed && (
                <Button variant="danger-ghost" onClick={() => setConfirm(true)}>
                  Uninstall bundle
                </Button>
              )}
            </div>
          )}
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={`Uninstall ${p.name}?`}
            description={t.reword(
              `This removes the ${t.standingOrders}, playbooks, knowledge templates and sample data this bundle added. Anything your organization created or edited is kept. Journey templates stay in the Journeys gallery.`,
            )}
            confirmLabel="Uninstall bundle"
            pending={remove.isPending}
            onConfirm={() =>
              remove.mutate(p.id, {
                onSuccess: (r) => {
                  setConfirm(false);
                  setResult({ kind: 'uninstall', r });
                  toast.success(`${p.name} uninstalled`);
                },
                onError: () => setConfirm(false),
              })
            }
          />
        </>
      )}
    </div>
  );
}

/** Industry bundles of a business organization: list, preview, install and uninstall in one action. */
export function IndustryBundlesDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const t = useOrgTerms();
  const [bundleId, setBundleId] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const reset = () => {
    setBundleId(null);
    setResult(null);
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Industry bundles"
      description={t.reword(
        `Everything one industry needs in one install: ${t.standingOrders}, playbooks, knowledge templates, sample data and journey templates.`,
      )}
      size="lg"
    >
      <div className="overflow-y-auto">
        {bundleId ? (
          <BundlePreview bundleId={bundleId} result={result} setResult={setResult} onBack={reset} />
        ) : (
          <BundleList onOpen={setBundleId} />
        )}
      </div>
    </Dialog>
  );
}
