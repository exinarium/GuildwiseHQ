import type { InterestDto } from '@aom/shared';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  useInterest,
  useInterests,
  usePatchInterest,
  useRunInterest,
  useSaveTasteSeed,
  useTasteSeed,
} from '../api/queries/interests.ts';
import { useProjects } from '../api/queries/projects.ts';
import { AdoptSchedulesDialog } from '../components/interests/AdoptSchedulesDialog.tsx';
import { InterestDrawer } from '../components/interests/InterestDrawer.tsx';
import { ResearchThisDialog } from '../components/interests/ResearchThisDialog.tsx';
import { TasteRulesEditor } from '../components/interests/TasteRulesEditor.tsx';
import {
  Badge,
  Button,
  Dialog,
  ErrorBox,
  PageHeader,
  Panel,
  Select,
  Spinner,
  TextInput,
} from '../components/ui.tsx';
import { compactRatings, describeRatings, describeScan } from '../lib/interests.ts';
import { formatDateTime } from '../lib/time.ts';

const linkBtn =
  'inline-flex min-h-11 items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-1 text-sm font-medium text-zinc-800 hover:bg-zinc-50 sm:min-h-8 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800';

/** Everything the manager cares about, across feed and research projects (docs/design/interests.md section 8.2). */
export function Interests() {
  const [params, setParams] = useSearchParams();
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState<'' | 'active' | 'paused'>('');
  const [search, setSearch] = useState('');
  const list = useInterests({ projectId: projectId || undefined, status: status || undefined });
  const projects = useProjects();
  const [editing, setEditing] = useState<InterestDto | 'new' | null>(null);
  const [researching, setResearching] = useState<InterestDto | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [bannerHidden, setBannerHidden] = useState(false);
  const [tasteProject, setTasteProject] = useState<string | null>(null);

  // Deep link: /interests?open=<id> opens the drawer.
  const openId = params.get('open');
  useEffect(() => {
    if (!openId || !list.data) return;
    const found = list.data.interests.find((i) => i.id === openId);
    if (found) {
      setEditing(found);
      const next = new URLSearchParams(params);
      next.delete('open');
      setParams(next, { replace: true });
    }
  }, [openId, list.data, params, setParams]);

  const needle = search.trim().toLowerCase();
  const shown = (list.data?.interests ?? []).filter(
    (i) => !needle || i.name.toLowerCase().includes(needle) || i.description.toLowerCase().includes(needle),
  );
  const adoptable = list.data?.adoptableCount ?? 0;
  const involved = new Set(
    (list.data?.interests ?? []).flatMap((i) => [i.feedProject?.id, i.researchProject?.id]),
  );
  const filterProjects = (projects.data ?? []).filter((p) => involved.has(p.id) || p.id === projectId);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-3">
      <PageHeader
        title="Interests"
        sub="What you care about across feed and research projects."
        actions={
          <>
            {adoptable > 0 && (
              <Button
                className="min-h-11 sm:min-h-8"
                data-testid="adopt-open"
                onClick={() => setAdopting(true)}
              >
                Adopt {adoptable} {adoptable === 1 ? 'schedule' : 'schedules'}
              </Button>
            )}
            <Button
              variant="primary"
              className="min-h-11 sm:min-h-8"
              data-testid="interest-new"
              onClick={() => setEditing('new')}
            >
              + New
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-36">
          <Select
            label="Project"
            value={projectId}
            data-testid="interests-project-filter"
            onChange={(e) => setProjectId(e.target.value)}
          >
            <option value="">All projects</option>
            {filterProjects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.key} {p.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="min-w-32">
          <Select
            label="Status"
            value={status}
            data-testid="interests-status-filter"
            onChange={(e) => setStatus(e.target.value as '' | 'active' | 'paused')}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </Select>
        </div>
        <div className="min-w-40 flex-1">
          <TextInput
            label="Search"
            value={search}
            data-testid="interests-search"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {adoptable > 0 && !bannerHidden && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
          data-testid="adopt-banner"
        >
          <span className="min-w-0 flex-1">
            {adoptable} feed {adoptable === 1 ? 'schedule is not an interest' : 'schedules are not interests'}{' '}
            yet.
          </span>
          <Button className="min-h-11 sm:min-h-8" onClick={() => setAdopting(true)}>
            Review and adopt
          </Button>
          <Button variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setBannerHidden(true)}>
            Dismiss
          </Button>
        </div>
      )}

      {list.isPending && <Spinner label="Loading interests" />}
      <ErrorBox error={list.error} />
      <ul className="flex flex-col gap-3" aria-label="Interests" data-testid="interests">
        {shown.map((i) => (
          <li key={i.id} data-testid={`interest-${i.name}`}>
            <InterestCard interest={i} onEdit={() => setEditing(i)} onResearch={() => setResearching(i)} />
          </li>
        ))}
      </ul>
      {list.data && shown.length === 0 && (
        <Panel>
          <p className="text-sm text-zinc-500" data-testid="interests-empty">
            No interests yet. Add one with + New, or adopt the feed schedules you already have.
          </p>
        </Panel>
      )}

      {(list.data?.tasteProjects ?? []).length > 0 && (
        <Panel data-testid="taste-projects">
          <h2 className="mb-2 text-sm font-semibold">Project taste rules</h2>
          <ul className="flex flex-col gap-2">
            {list.data?.tasteProjects.map((t) => (
              <li
                key={t.projectId}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
                data-testid={`taste-project-${t.key}`}
              >
                <span>
                  {t.key}: {t.ruleCount} explicit {t.ruleCount === 1 ? 'rule' : 'rules'}
                  {t.hasVault ? ` · written to taste.md v${t.version}` : ' · no vault, brief only'}
                </span>
                <Button className="min-h-11 sm:min-h-8" onClick={() => setTasteProject(t.projectId)}>
                  Edit taste rules
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {editing && (
        <InterestDrawer
          key={editing === 'new' ? 'new' : editing.id}
          interest={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {researching && <ResearchThisDialog interest={researching} onClose={() => setResearching(null)} />}
      <AdoptSchedulesDialog open={adopting} onClose={() => setAdopting(false)} />
      {tasteProject && <ProjectTasteDialog projectId={tasteProject} onClose={() => setTasteProject(null)} />}
    </div>
  );
}

function InterestCard({
  interest: i,
  onEdit,
  onResearch,
}: {
  interest: InterestDto;
  onEdit: () => void;
  onResearch: () => void;
}) {
  const run = useRunInterest();
  const patch = usePatchInterest();
  const [showNotes, setShowNotes] = useState(false);
  const s = i.stats;
  const archived = !!(i.feedProject?.archived || i.researchProject?.archived);
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{i.name}</h2>
        <Badge tone={i.status === 'active' ? 'green' : 'amber'}>
          {i.status === 'active' ? 'Active' : 'Paused'}
        </Badge>
        {archived && <Badge tone="neutral">project archived</Badge>}
        {s.failing && (
          <Badge tone="red" title={i.schedule?.lastError ?? undefined}>
            Cannot run ({i.schedule?.failCount} {i.schedule?.failCount === 1 ? 'try' : 'tries'})
          </Badge>
        )}
        <span className="ml-auto text-xs text-zinc-500" data-testid="interest-projects">
          {i.feedProject && <span title="feed project">{i.feedProject.key} (feed)</span>}
          {i.feedProject && i.researchProject && ' · '}
          {i.researchProject && <span title="research project">{i.researchProject.key} (research)</span>}
          {i.subCategory && ` · ${i.subCategory}`}
        </span>
      </div>
      {i.description && (
        <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{i.description}</p>
      )}
      {s.failing && i.schedule?.lastError && (
        <p className="mt-1 text-xs text-red-700 dark:text-red-400">{i.schedule.lastError}</p>
      )}
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm">
        {i.feedProject && (
          <>
            <div data-testid="interest-cadence">{describeScan(i.scan)}</div>
            <div className="text-zinc-600 dark:text-zinc-400" data-testid="interest-last-scan">
              {s.lastScanAt ? (
                <>
                  Last scan {formatDateTime(s.lastScanAt)}
                  {s.lastScanCard && (
                    <>
                      {' '}
                      (
                      <Link to={`/cards/${s.lastScanCard.id}`} className="underline">
                        {s.lastScanCard.ref}
                      </Link>
                      , {s.items.lastScan} {s.items.lastScan === 1 ? 'item' : 'items'})
                    </>
                  )}
                </>
              ) : (
                'No scan yet'
              )}
              {' · '}next {s.nextScanAt ? formatDateTime(s.nextScanAt) : 'not scheduled'}
            </div>
            <div data-testid="interest-ratings">
              <span className="hidden sm:inline">Ratings {describeRatings(s.ratings)}</span>
              <span className="sm:hidden">{compactRatings(s.ratings)}</span>
              <span className="text-zinc-500">
                {' '}
                · scans 30d {s.scans30d} · items {s.items.total}
              </span>
            </div>
          </>
        )}
        {i.researchProject && (
          <div data-testid="interest-notes-line">
            Notes {s.research.published} · open {s.research.open}
          </div>
        )}
      </dl>
      <ErrorBox error={run.error ?? patch.error} />
      {run.data && (
        <p className="mt-2 text-sm" data-testid="interest-run-result">
          Emitted{' '}
          <Link to={`/cards/${run.data.ref}`} className="underline">
            {run.data.ref}
          </Link>
          .
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {i.canRun && i.scheduleId && (
          <Button
            variant="primary"
            className="min-h-11 sm:min-h-8"
            disabled={run.isPending || archived}
            data-testid="interest-run"
            onClick={() => run.mutate(i.id)}
          >
            Run now
          </Button>
        )}
        {i.canResearch && (
          <Button className="min-h-11 sm:min-h-8" data-testid="interest-research" onClick={onResearch}>
            Research this
          </Button>
        )}
        {i.feedProject && (
          <Link
            to={`/p/${i.feedProject.key}/feed?interest=${i.id}`}
            className={linkBtn}
            data-testid="interest-digests"
          >
            Digests
          </Link>
        )}
        {i.researchProject && (
          <Button
            className="min-h-11 sm:min-h-8"
            data-testid="interest-notes"
            onClick={() => setShowNotes((x) => !x)}
          >
            Notes
          </Button>
        )}
        <span className="ml-auto flex gap-2">
          {i.canManage && (
            <Button
              className="min-h-11 sm:min-h-8"
              disabled={patch.isPending}
              data-testid="interest-toggle"
              onClick={() =>
                patch.mutate({ id: i.id, body: { status: i.status === 'active' ? 'paused' : 'active' } })
              }
            >
              {i.status === 'active' ? 'Pause' : 'Resume'}
            </Button>
          )}
          <Button className="min-h-11 sm:min-h-8" data-testid="interest-edit" onClick={onEdit}>
            {i.canManage ? 'Edit' : 'View'}
          </Button>
        </span>
      </div>
      {showNotes && <InterestNotes id={i.id} />}
    </Panel>
  );
}

/** Last scans and notes of one interest (the detail query). */
function InterestNotes({ id }: { id: string }) {
  const d = useInterest(id);
  if (d.isPending) return <Spinner />;
  return (
    <div
      className="mt-3 grid gap-3 border-t border-zinc-200 pt-3 text-sm sm:grid-cols-2 dark:border-zinc-800"
      data-testid="interest-notes-panel"
    >
      <div>
        <h3 className="mb-1 text-xs font-semibold text-zinc-500">Recent scans</h3>
        {d.data?.scans.length === 0 && <p className="text-zinc-500">None yet.</p>}
        <ul>
          {d.data?.scans.map((s) => (
            <li key={s.cardId}>
              <Link to={`/cards/${s.cardId}`} className="underline">
                {s.ref}
              </Link>{' '}
              {s.nothingQualified ? 'nothing qualified' : `${s.items} items`} · {s.status}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-xs font-semibold text-zinc-500">Notes</h3>
        {d.data?.publications.length === 0 && <p className="text-zinc-500">None yet.</p>}
        <ul data-testid="interest-publications">
          {d.data?.publications.map((p) => (
            <li key={p.id}>
              <Link to={`/cards/${p.cardId}`} className="underline">
                {p.cardRef}
              </Link>{' '}
              {p.title}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Project-wide explicit rules (untagged); rules tagged with an interest are edited in that interest's drawer. */
function ProjectTasteDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const seed = useTasteSeed(projectId);
  const save = useSaveTasteSeed();
  const list = useInterests();
  const [rules, setRules] = useState<string[] | null>(null);
  useEffect(() => {
    if (seed.data && rules === null)
      setRules(seed.data.rules.filter((r) => !r.interestId).map((r) => r.text));
  }, [seed.data, rules]);
  const names = new Map((list.data?.interests ?? []).map((i) => [i.id, i.name]));
  const tagged = (seed.data?.rules ?? []).filter((r) => r.interestId);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Project taste rules"
      description="Explicit rules for every scan of this project. The curators follow them before the rules from your ratings."
    >
      <div className="flex flex-col gap-3" data-testid="project-taste-dialog">
        {rules === null ? (
          <Spinner />
        ) : (
          <TasteRulesEditor rules={rules} onChange={setRules} testId="project-taste-rules" />
        )}
        {tagged.length > 0 && (
          <div className="text-xs text-zinc-500">
            <p className="font-medium">Rules of single interests (edit them on the interest)</p>
            <ul className="list-disc pl-4">
              {tagged.map((r) => (
                <li key={`${r.interestId}-${r.text}`}>
                  {r.text} ({names.get(r.interestId as string) ?? 'interest'})
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorBox error={save.error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            data-testid="project-taste-save"
            disabled={save.isPending || rules === null}
            onClick={() =>
              save.mutate(
                {
                  projectId,
                  rules: [...(rules ?? []).map((text) => ({ text, interestId: null })), ...tagged],
                },
                { onSuccess: onClose },
              )
            }
          >
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
