import type { DeployTargetDto, DeployTargetKind, ProjectWorkstation } from '@aom/shared';
import { Pencil } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useCheckTarget } from '../api/queries/deploy-connect.ts';
import {
  useAddDeployTarget,
  useDeployTargets,
  usePatchDeployTarget,
  useProjectWorkstations,
  useRemoveDeployTarget,
} from '../api/queries/phases.ts';
import { ConnectServer } from './delivery/connect/ConnectServer.tsx';
import { KeysList } from './delivery/connect/KeysList.tsx';
import { needsReconnect, ReachabilityChip } from './delivery/connect/ReachabilityChip.tsx';
import { TargetTesting } from './runs/TargetTesting.tsx';
import {
  Badge,
  Button,
  Dialog,
  Disclosure,
  ErrorBox,
  Panel,
  Select,
  TextArea,
  TextInput,
  useToast,
} from './ui.tsx';

/**
 * Where a phase can be deployed: the project's deploy targets (any member manages them). "On a computer" runs Docker on
 * a workstation of the project (one you pick, or every member's); "On my own server" names the workstation whose DevOps
 * engineer deploys over SSH. A target can be marked production, the live site customers use (docs/design/deploy-run-ux-design.md
 * section 3.2). No credentials are stored: SSH keys and Docker stay on the workstations.
 */

/** "Deploys from: Office PC, online" for a target card. */
export function deploysFrom(
  t: Pick<DeployTargetDto, 'kind' | 'workstationId' | 'workstationName'>,
  workstations: ProjectWorkstation[],
): { text: string; online: boolean | null } {
  if (!t.workstationId)
    return t.kind === 'local_docker'
      ? { text: 'any computer of the project', online: null }
      : { text: 'not set', online: null };
  const w = workstations.find((x) => x.id === t.workstationId);
  return { text: t.workstationName ?? w?.name ?? 'a computer', online: w ? w.connected : null };
}

const PRODUCTION_HINT =
  'Production is never used for tests, and every release needs your approval. Leave this off for a test copy.';

export function DeployTargetsPanel({ projectId }: { projectId: string }) {
  const targets = useDeployTargets(projectId);
  const workstations = useProjectWorkstations(projectId);
  const add = useAddDeployTarget(projectId);
  const remove = useRemoveDeployTarget(projectId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DeployTargetKind>('local_docker');
  const [workstationId, setWorkstationId] = useState('');
  const [host, setHost] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [production, setProduction] = useState(false);
  const [err, setErr] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<DeployTargetDto | null>(null);
  const [reconnecting, setReconnecting] = useState<DeployTargetDto | null>(null);
  const check = useCheckTarget(projectId);
  const toast = useToast();
  const ws = workstations.data ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'A name is required';
    if (kind === 'remote_ssh' && !workstationId) errs.workstation = 'Choose the workstation that deploys';
    if (kind === 'remote_ssh' && !host.trim()) errs.host = 'An SSH host alias is required';
    setErr(errs);
    if (Object.keys(errs).length) return;
    add.mutate(
      {
        name: name.trim(),
        kind,
        ...(workstationId ? { workstationId } : {}),
        ...(kind === 'remote_ssh' ? { host: host.trim() } : {}),
        ...(appUrl.trim() ? { appUrl: appUrl.trim() } : {}),
        notes,
        production,
      },
      {
        onSuccess: () => {
          setName('');
          setHost('');
          setAppUrl('');
          setNotes('');
          setProduction(false);
        },
      },
    );
  };

  return (
    <Panel data-testid="deploy-targets">
      <h2 className="mb-2 text-lg font-semibold text-fg">Deploy targets</h2>
      <p className="mb-2 text-xs text-subtle">
        Where a phase can be deployed. No passwords or keys are stored here: SSH keys and Docker stay on the
        workstation of the DevOps engineer that deploys.
      </p>
      <ul className="mb-3 flex flex-col gap-2" data-testid="deploy-target-list">
        {(targets.data ?? []).map((t) => {
          const from = deploysFrom(t, ws);
          return (
            <li
              key={t.id}
              className="flex flex-wrap items-start justify-between gap-2 rounded-control border border-line p-3 text-sm"
              data-testid={`deploy-target-${t.name}`}
            >
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  {t.production && (
                    <Badge tone="warning" data-testid="target-production-badge">
                      Production
                    </Badge>
                  )}
                  <Badge>{t.kind === 'local_docker' ? 'Docker on a computer' : `Server ${t.host}`}</Badge>
                  {t.role === 'standby' && (
                    <Badge tone="warning" data-testid="target-standby-badge">
                      Standby (fallback)
                    </Badge>
                  )}
                  {t.role === 'retired' && <Badge data-testid="target-retired-badge">Retired</Badge>}
                </span>
                <span className="mt-1 block text-xs text-muted" data-testid="target-deploys-from">
                  Deploys from: <span className="font-medium text-fg">{from.text}</span>
                  {from.online !== null && (
                    <span className={from.online ? ' text-success' : ' text-subtle'}>
                      {from.online ? ' (online)' : ' (offline)'}
                    </span>
                  )}
                </span>
                {t.kind === 'remote_ssh' && (
                  <span className="mt-1 flex flex-col gap-1.5" data-testid={`target-connection-${t.name}`}>
                    <ReachabilityChip reachability={t.reachability} />
                    <span className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant={needsReconnect(t.reachability) ? 'primary' : 'secondary'}
                        onClick={() => setReconnecting(t)}
                        data-testid={`target-reconnect-${t.name}`}
                      >
                        {needsReconnect(t.reachability)
                          ? 'Reconnect from this computer'
                          : 'Use another computer'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={check.isPending && check.variables === t.id}
                        onClick={() =>
                          check.mutate(t.id, { onSuccess: () => toast.success('Checking the connection') })
                        }
                        data-testid={`target-check-${t.name}`}
                      >
                        Check connection
                      </Button>
                    </span>
                    {(t.keys?.length ?? 0) > 0 && (
                      <Disclosure
                        summary={`Guildwise keys on this server (${t.keys?.filter((k) => k.state === 'active').length ?? 0})`}
                      >
                        <KeysList
                          projectId={projectId}
                          targetId={t.id}
                          keys={t.keys ?? []}
                          signInWorkstationId={
                            ws.find((w) => w.id === t.workstationId && w.mine)?.id ??
                            ws.find(
                              (w) =>
                                w.mine &&
                                t.keys?.some((k) => k.workstationId === w.id && k.state === 'active'),
                            )?.id ??
                            null
                          }
                        />
                      </Disclosure>
                    )}
                    <ErrorBox error={check.error} />
                  </span>
                )}
                {t.appUrl && <span className="block font-mono text-xs text-subtle">{t.appUrl}</span>}
                <TargetTesting projectId={projectId} target={t} workstations={ws} />
              </span>
              <span className="flex gap-1">
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Edit deploy target ${t.name}`}
                  onClick={() => setEditing(t)}
                >
                  <Pencil aria-hidden="true" className="size-4" />
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove deploy target ${t.name}`}
                  onClick={() => remove.mutate(t.id)}
                >
                  Remove
                </Button>
              </span>
            </li>
          );
        })}
        {targets.data?.length === 0 && <li className="text-sm text-subtle">No deploy targets yet.</li>}
      </ul>
      <form onSubmit={submit} noValidate aria-label="Add deploy target" className="grid gap-3 sm:grid-cols-2">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} error={err.name} />
        <Select
          label="Where does it run?"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value as DeployTargetKind);
            setWorkstationId('');
          }}
        >
          <option value="local_docker">On a computer (Docker)</option>
          <option value="remote_ssh">On my own server (over SSH)</option>
        </Select>
        <WorkstationSelect
          kind={kind}
          value={workstationId}
          onChange={setWorkstationId}
          workstations={ws}
          error={err.workstation}
        />
        {kind === 'remote_ssh' && (
          <TextInput
            label="SSH host"
            hint="An alias from ~/.ssh/config, or user@host. No passwords."
            value={host}
            onChange={(e) => setHost(e.target.value)}
            error={err.host}
          />
        )}
        <TextInput label="App URL (optional)" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} />
        <div className="sm:col-span-2">
          <ProductionCheckbox checked={production} onChange={setProduction} />
        </div>
        <div className="sm:col-span-2">
          <TextArea
            label="How to deploy (notes)"
            hint="The compose file, the script, the environment: the DevOps engineer reads this."
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <ErrorBox error={add.error ?? remove.error} />
        <Button
          type="submit"
          variant="primary"
          className="justify-self-start sm:col-span-2"
          disabled={add.isPending}
        >
          Add deploy target
        </Button>
      </form>
      {reconnecting && (
        <Dialog
          open
          onOpenChange={(o) => !o && setReconnecting(null)}
          title={`Reconnect ${reconnecting.name}`}
          size="lg"
        >
          <ConnectServer
            heading={false}
            projectId={projectId}
            target={reconnecting}
            onCancel={() => setReconnecting(null)}
            onDone={() => {
              setReconnecting(null);
              toast.success('Connected');
            }}
          />
        </Dialog>
      )}
      {editing && (
        <EditTarget
          projectId={projectId}
          target={editing}
          workstations={ws}
          onClose={() => setEditing(null)}
        />
      )}
    </Panel>
  );
}

function ProductionCheckbox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex min-h-9 items-center gap-2 text-sm font-medium [@media(pointer:coarse)]:min-h-11">
        <input
          type="checkbox"
          checked={checked}
          data-testid="target-production-checkbox"
          onChange={(e) => onChange(e.target.checked)}
        />
        This is the live site your customers use (production)
      </label>
      <p className="pl-6 text-xs text-subtle">{PRODUCTION_HINT}</p>
    </div>
  );
}

function WorkstationSelect({
  kind,
  value,
  onChange,
  workstations,
  error,
}: {
  kind: DeployTargetKind;
  value: string;
  onChange: (v: string) => void;
  workstations: ProjectWorkstation[];
  error?: string | undefined;
}) {
  const options = workstations.map((w) => (
    <option key={w.id} value={w.id}>
      {w.name} ({w.mine ? 'yours' : w.ownerName}){w.hasDevops ? '' : ', no DevOps engineer'}
      {w.connected ? '' : ', offline'}
    </option>
  ));
  if (kind === 'remote_ssh')
    return (
      <Select
        label="Workstation that deploys"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        error={error}
      >
        <option value="">Choose a workstation</option>
        {options}
      </Select>
    );
  return (
    <Select
      label="Which computer?"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      hint="The computer whose Docker runs it. Leave it open to deploy on every computer of the project."
    >
      <option value="">Every computer of the project</option>
      {options}
    </Select>
  );
}

function EditTarget({
  projectId,
  target,
  workstations,
  onClose,
}: {
  projectId: string;
  target: DeployTargetDto;
  workstations: ProjectWorkstation[];
  onClose: () => void;
}) {
  const patch = usePatchDeployTarget(projectId);
  const toast = useToast();
  const [name, setName] = useState(target.name);
  const [workstationId, setWorkstationId] = useState(target.workstationId ?? '');
  const [host, setHost] = useState(target.host ?? '');
  const [appUrl, setAppUrl] = useState(target.appUrl ?? '');
  const [notes, setNotes] = useState(target.notes);
  const [production, setProduction] = useState(target.production ?? false);
  const [problem, setProblem] = useState<string | undefined>();
  const save = (e: FormEvent) => {
    e.preventDefault();
    setProblem(undefined);
    if (!name.trim()) return setProblem('A name is required');
    if (target.kind === 'remote_ssh' && (!workstationId || !host.trim()))
      return setProblem('A server needs the workstation that deploys and an SSH host.');
    if (production && target.testEnabled)
      return setProblem('A production target is never tested: switch testing off for this target first.');
    patch.mutate(
      {
        id: target.id,
        body: {
          name: name.trim(),
          workstationId: workstationId || null,
          ...(target.kind === 'remote_ssh' ? { host: host.trim() } : {}),
          appUrl: appUrl.trim() || null,
          notes,
          production,
        },
      },
      {
        onSuccess: () => {
          toast.success(`${name.trim()} saved`);
          onClose();
        },
      },
    );
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Edit ${target.name}`}
      size="lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="edit-target-form" loading={patch.isPending}>
            Save
          </Button>
        </>
      }
    >
      <form
        id="edit-target-form"
        onSubmit={save}
        noValidate
        className="flex flex-col gap-3"
        aria-label="Edit deploy target"
      >
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <WorkstationSelect
          kind={target.kind}
          value={workstationId}
          onChange={setWorkstationId}
          workstations={workstations}
        />
        {target.kind === 'remote_ssh' && (
          <TextInput label="SSH host" value={host} onChange={(e) => setHost(e.target.value)} />
        )}
        <TextInput label="App URL (optional)" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} />
        <ProductionCheckbox checked={production} onChange={setProduction} />
        <TextArea label="How to deploy (notes)" value={notes} onChange={(e) => setNotes(e.target.value)} />
        {problem && (
          <p role="alert" className="text-sm font-medium text-danger">
            {problem}
          </p>
        )}
        <ErrorBox error={patch.error} />
      </form>
    </Dialog>
  );
}
