import type { DeployTargetKind } from '@aom/shared';
import { type FormEvent, useState } from 'react';
import { useAddDeployTarget, useDeployTargets, useRemoveDeployTarget } from '../api/queries/phases.ts';
import { useWorkstations } from '../api/queries/workstations.ts';
import { Badge, Button, ErrorBox, Panel, Select, TextArea, TextInput } from './ui.tsx';

/**
 * Where a phase can be deployed: the project's deploy targets (any member manages them). A local Docker target deploys
 * on every workstation of every member; a remote host names the workstation whose DevOps engineer does it over SSH.
 * No credentials are stored: SSH keys and Docker stay on the workstations.
 */
export function DeployTargetsPanel({ projectId }: { projectId: string }) {
  const targets = useDeployTargets(projectId);
  const workstations = useWorkstations();
  const add = useAddDeployTarget(projectId);
  const remove = useRemoveDeployTarget(projectId);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<DeployTargetKind>('local_docker');
  const [workstationId, setWorkstationId] = useState('');
  const [host, setHost] = useState('');
  const [appUrl, setAppUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [err, setErr] = useState<Record<string, string>>({});

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
        ...(kind === 'remote_ssh' ? { workstationId, host: host.trim() } : {}),
        ...(appUrl.trim() ? { appUrl: appUrl.trim() } : {}),
        notes,
      },
      {
        onSuccess: () => {
          setName('');
          setHost('');
          setAppUrl('');
          setNotes('');
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
      <ul className="mb-3 flex flex-col gap-1.5" data-testid="deploy-target-list">
        {(targets.data ?? []).map((t) => (
          <li key={t.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              <span className="font-medium">{t.name}</span>{' '}
              <Badge>
                {t.kind === 'local_docker' ? 'local Docker (every member workstation)' : `ssh ${t.host}`}
              </Badge>{' '}
              {t.workstationName && <span className="text-xs text-subtle">via {t.workstationName}</span>}{' '}
              {t.appUrl && <span className="font-mono text-xs text-subtle">{t.appUrl}</span>}
            </span>
            <Button
              variant="ghost"
              aria-label={`Remove deploy target ${t.name}`}
              onClick={() => remove.mutate(t.id)}
            >
              Remove
            </Button>
          </li>
        ))}
        {targets.data?.length === 0 && <li className="text-sm text-subtle">No deploy targets yet.</li>}
      </ul>
      <form onSubmit={submit} noValidate aria-label="Add deploy target" className="grid gap-3 sm:grid-cols-2">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} error={err.name} />
        <Select label="Kind" value={kind} onChange={(e) => setKind(e.target.value as DeployTargetKind)}>
          <option value="local_docker">Local Docker stack</option>
          <option value="remote_ssh">Remote host over SSH</option>
        </Select>
        {kind === 'remote_ssh' && (
          <>
            <Select
              label="Workstation that deploys"
              value={workstationId}
              onChange={(e) => setWorkstationId(e.target.value)}
              error={err.workstation}
            >
              <option value="">Choose a workstation</option>
              {(workstations.data ?? []).map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            <TextInput
              label="SSH host"
              hint="An alias from ~/.ssh/config, or user@host. No passwords."
              value={host}
              onChange={(e) => setHost(e.target.value)}
              error={err.host}
            />
          </>
        )}
        <TextInput label="App URL (optional)" value={appUrl} onChange={(e) => setAppUrl(e.target.value)} />
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
    </Panel>
  );
}
