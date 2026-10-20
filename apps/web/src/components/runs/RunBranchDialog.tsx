import { type ProjectRepoDto, type RunDeclaredService, withDependencies } from '@aom/shared';
import { Play } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useProject } from '../../api/queries/projects.ts';
import { useRunSettings, useStartRun } from '../../api/queries/runs.ts';
import { useWorkstations } from '../../api/queries/workstations.ts';
import { Button, Callout, Dialog, ErrorBox, Select, useToast } from '../ui.tsx';

/** What the card page passes: the card whose branch runs (its repository runs at the card branch, the others at their working branch). */
export interface RunCard {
  id: string;
  ref: string;
  repoId: string | null;
  homeWorkstationId: string | null;
}

const branchesOf = (r: ProjectRepoDto): string[] => [
  ...new Set([...(r.workingBranch ? [r.workingBranch] : []), ...(r.knownBranches ?? [])]),
];

/**
 * "Run this branch" (card page) and "Run branch..." (project page): per-repository branch picker, service checkboxes and
 * a workstation picker. Starting files a DevOps request on that workstation; the environment panel shows how it goes.
 */
export function RunBranchDialog({
  projectId,
  card,
  label,
  onStarted,
}: {
  projectId: string;
  card?: RunCard;
  label?: string;
  onStarted?: (envId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button data-testid="run-branch-open" onClick={() => setOpen(true)}>
        <Play aria-hidden="true" className="size-4" />
        {label ?? (card ? 'Run this branch' : 'Run branch...')}
      </Button>
      {open && (
        <RunBranchForm
          projectId={projectId}
          {...(card ? { card } : {})}
          onClose={() => setOpen(false)}
          {...(onStarted ? { onStarted } : {})}
        />
      )}
    </>
  );
}

function RunBranchForm({
  projectId,
  card,
  onClose,
  onStarted,
}: {
  projectId: string;
  card?: RunCard;
  onClose: () => void;
  onStarted?: (envId: string) => void;
}) {
  const project = useProject(projectId);
  const settings = useRunSettings(projectId);
  const workstations = useWorkstations();
  const start = useStartRun();
  const toast = useToast();
  const repos = (project.data?.repos ?? []).filter((r) => !r.removedAt);
  const declared: RunDeclaredService[] = settings.data?.settings.services ?? [];

  const [branches, setBranches] = useState<Record<string, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [wsId, setWsId] = useState('');

  // Workstations that can do it: online, new enough runner, and holding a clone of one of the project's repositories.
  const candidates = useMemo(
    () =>
      (workstations.data ?? []).filter(
        (w) =>
          w.status === 'active' &&
          w.connected &&
          w.runs?.capable &&
          w.repos.some((x) => repos.some((r) => r.id === x.projectRepoId)),
      ),
    [workstations.data, repos],
  );
  useEffect(() => {
    if (wsId && candidates.some((w) => w.id === wsId)) return;
    const home = card?.homeWorkstationId
      ? candidates.find((w) => w.id === card.homeWorkstationId)
      : undefined;
    setWsId((home ?? candidates[0])?.id ?? '');
  }, [candidates, wsId, card?.homeWorkstationId]);

  const ws = candidates.find((w) => w.id === wsId);
  const cloned = (repoId: string) => !!ws?.repos.some((x) => x.projectRepoId === repoId);

  // `ticked` holds the user's choices; a service another one needs is on and greyed out.
  const wanted = declared.filter((s) => ticked[s.name] ?? true);
  const needed = new Set(
    withDependencies(
      declared.map((s) => ({ name: s.name, after: s.after })),
      wanted.map((s) => s.name),
    ).map((s) => s.name),
  );
  const allServices = declared.length > 0 && declared.every((s) => needed.has(s.name));

  const submit = () => {
    const chosen = repos
      .filter((r) => cloned(r.id) && (included[r.id] ?? true))
      .map((r) => ({ repoId: r.id, branch: branches[r.id] ?? r.workingBranch ?? '' }))
      .filter((s) => s.branch);
    start.mutate(
      {
        projectId,
        ...(wsId ? { workstationId: wsId } : {}),
        ...(card ? { cardId: card.id } : { sources: chosen }),
        ...(declared.length > 0 && !allServices ? { services: [...needed] } : {}),
      },
      {
        onSuccess: (env) => {
          toast.success('Starting: the DevOps engineer is on it');
          onStarted?.(env.id);
          onClose();
        },
      },
    );
  };

  const nothing = !project.isPending && !workstations.isPending && candidates.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={card ? `Run ${card.ref}'s branch` : 'Run a branch'}
      description="Starts the project on a workstation so you can try it. The DevOps engineer of that workstation works out how, the first time; the environment stops by itself after a few hours."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            data-testid="run-branch-start"
            loading={start.isPending}
            disabled={!wsId || (!card && repos.every((r) => !cloned(r.id)))}
            onClick={submit}
          >
            Start
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {nothing && (
          <Callout tone="warning">
            No workstation is ready: it must be online, run an up to date runner and hold a clone of the
            project's repository.
          </Callout>
        )}
        <Select
          label="Workstation"
          value={wsId}
          onChange={(e) => setWsId(e.target.value)}
          data-testid="run-workstation"
        >
          {candidates.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>

        {card ? (
          <p className="text-sm text-muted">
            Runs the branch of {card.ref} in its repository; the project's other repositories run at their
            working branch.
          </p>
        ) : (
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">Repositories and branches</legend>
            {repos.map((r) => (
              <div key={r.id} className="flex flex-wrap items-end gap-3">
                <label className="flex min-h-9 items-center gap-2 text-sm [@media(pointer:coarse)]:min-h-11">
                  <input
                    type="checkbox"
                    data-testid={`run-repo-${r.name}`}
                    checked={cloned(r.id) && (included[r.id] ?? true)}
                    disabled={!cloned(r.id)}
                    onChange={(e) => setIncluded((cur) => ({ ...cur, [r.id]: e.target.checked }))}
                  />
                  {r.name}
                </label>
                <div className="min-w-48 flex-1">
                  <Select
                    label={`Branch of ${r.name}`}
                    data-testid={`run-branch-${r.name}`}
                    value={branches[r.id] ?? r.workingBranch ?? ''}
                    disabled={!cloned(r.id)}
                    hint={cloned(r.id) ? undefined : `Not cloned on ${ws?.name ?? 'this workstation'}`}
                    onChange={(e) => setBranches((cur) => ({ ...cur, [r.id]: e.target.value }))}
                  >
                    {branchesOf(r).map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            ))}
          </fieldset>
        )}

        {declared.length > 1 && (
          <fieldset className="flex flex-col gap-1" data-testid="run-services">
            <legend className="mb-1 text-sm font-medium">Services</legend>
            {declared.map((s) => {
              const forced = needed.has(s.name) && !(ticked[s.name] ?? true);
              return (
                <label key={s.name} className="flex min-h-8 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    data-testid={`run-service-${s.name}`}
                    checked={needed.has(s.name)}
                    disabled={forced}
                    onChange={(e) => setTicked((cur) => ({ ...cur, [s.name]: e.target.checked }))}
                  />
                  {s.name}
                  {forced && <span className="text-xs text-muted">(needed by another service)</span>}
                </label>
              );
            })}
          </fieldset>
        )}
        <ErrorBox error={start.error} />
      </div>
    </Dialog>
  );
}
