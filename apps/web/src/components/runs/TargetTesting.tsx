import type { DeployTargetDto, ProjectWorkstation } from '@aom/shared';
import { type FormEvent, useEffect, useState } from 'react';
import { usePatchDeployTarget } from '../../api/queries/phases.ts';
import { useSetTargetSecret, useTargetSecrets } from '../../api/queries/runs.ts';
import { canSealHere } from '../../lib/secure.ts';
import { formatDateTime } from '../../lib/time.ts';
import { SecureContextNotice } from '../SecureContextNotice.tsx';
import { Badge, Button, Callout, ErrorBox, Select, TextInput, useToast } from '../ui.tsx';

const words = (s: string) => s.split(/[\s,]+/).filter(Boolean);

/**
 * "Testing" of a deploy target (backlog #59, phase 4): whether the tester may test the deployed app, which extra hosts its
 * sandbox may reach, which test accounts it gets (names here; the values are sealed in the browser for one workstation and
 * never reach the server), and whether tests may change data there. A production target is never tested.
 */
export function TargetTesting({
  projectId,
  target,
  workstations,
}: {
  projectId: string;
  target: DeployTargetDto;
  workstations: ProjectWorkstation[];
}) {
  const patch = usePatchDeployTarget(projectId);
  const toast = useToast();
  const [enabled, setEnabled] = useState(target.testEnabled ?? false);
  const [production, setProduction] = useState(target.production ?? false);
  const [destructive, setDestructive] = useState(target.destructiveOk ?? false);
  const [hosts, setHosts] = useState((target.testHosts ?? []).join(' '));
  const [names, setNames] = useState((target.secretNames ?? []).join(' '));
  const [problem, setProblem] = useState<string | undefined>();
  useEffect(() => {
    setEnabled(target.testEnabled ?? false);
    setProduction(target.production ?? false);
    setDestructive(target.destructiveOk ?? false);
    setHosts((target.testHosts ?? []).join(' '));
    setNames((target.secretNames ?? []).join(' '));
  }, [target]);

  const save = (e: FormEvent) => {
    e.preventDefault();
    setProblem(undefined);
    if (enabled && production)
      return setProblem('A production target is never tested: switch one of the two off.');
    if (enabled && !target.appUrl)
      return setProblem('Set the app URL of this target first: that is where the tester tests.');
    patch.mutate(
      {
        id: target.id,
        body: {
          testEnabled: enabled,
          production,
          destructiveOk: destructive,
          testHosts: words(hosts),
          secretNames: words(names),
        },
      },
      { onSuccess: () => toast.success(`Testing settings of ${target.name} saved`) },
    );
  };

  return (
    <details className="mt-1 text-sm" data-testid={`target-testing-${target.name}`}>
      <summary className="cursor-pointer text-xs font-medium text-muted">
        Testing:{' '}
        {target.production ? (
          <Badge tone="warning">production, never tested</Badge>
        ) : target.testEnabled ? (
          <Badge tone="success">the tester tests it</Badge>
        ) : (
          <Badge>off</Badge>
        )}
      </summary>
      <form
        onSubmit={save}
        noValidate
        className="mt-2 flex flex-col gap-2"
        aria-label={`Testing of ${target.name}`}
      >
        <label className="flex min-h-9 items-center gap-2">
          <input
            type="checkbox"
            checked={enabled}
            data-testid="target-test-enabled"
            onChange={(e) => setEnabled(e.target.checked)}
          />
          The tester may test this target (integration tests, remote mode)
        </label>
        <label className="flex min-h-9 items-center gap-2">
          <input
            type="checkbox"
            checked={production}
            data-testid="target-production"
            onChange={(e) => setProduction(e.target.checked)}
          />
          This is production (never tested)
        </label>
        <label className="flex min-h-9 items-center gap-2">
          <input
            type="checkbox"
            checked={destructive}
            data-testid="target-destructive"
            onChange={(e) => setDestructive(e.target.checked)}
          />
          Tests may write or delete data here
        </label>
        <TextInput
          label="Extra hosts the tester may reach"
          value={hosts}
          placeholder="api.staging.example.com"
          hint="Hostnames only, separated by spaces. The target's own address is always allowed; ports cannot be limited."
          onChange={(e) => setHosts(e.target.value)}
        />
        <TextInput
          label="Test accounts (names)"
          value={names}
          placeholder="TEST_USER_EMAIL TEST_USER_PASSWORD"
          hint="The tester gets these as a private file on its workstation. Set the values below."
          onChange={(e) => setNames(e.target.value)}
        />
        {problem && (
          <p role="alert" className="text-sm font-medium text-danger" data-testid="target-testing-problem">
            {problem}
          </p>
        )}
        <ErrorBox error={patch.error} />
        <div>
          <Button type="submit" loading={patch.isPending} data-testid="target-testing-save">
            Save testing settings
          </Button>
        </div>
      </form>
      {(target.secretNames ?? []).length > 0 && (
        <TargetSecretValues projectId={projectId} target={target} workstations={workstations} />
      )}
    </details>
  );
}

function TargetSecretValues({
  projectId,
  target,
  workstations,
}: {
  projectId: string;
  target: DeployTargetDto;
  workstations: ProjectWorkstation[];
}) {
  const mine = workstations.filter((w) => w.mine);
  const status = useTargetSecrets(projectId);
  const set = useSetTargetSecret(projectId);
  const toast = useToast();
  const [ws, setWs] = useState(mine[0]?.id ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  if (mine.length === 0)
    return <p className="mt-2 text-xs text-subtle">You have no workstation to hold the test accounts on.</p>;
  const held = (name: string) =>
    (status.data?.secrets ?? []).find(
      (s) => s.workstationId === ws && s.targetId === target.id && s.name === name,
    );
  return (
    <div
      className="mt-3 flex flex-col gap-2 border-t border-line pt-2"
      data-testid={`target-secrets-${target.name}`}
    >
      <p className="text-xs font-medium text-muted">Test account values</p>
      <Callout tone="info">
        A value is encrypted in your browser for the runner of the workstation you choose and kept only there.
        Guildwise never sees it, and it is hidden from everything the tester attaches to a card.
      </Callout>
      <SecureContextNotice />
      {mine.length > 1 && (
        <Select label="On workstation" value={ws} onChange={(e) => setWs(e.target.value)}>
          {mine.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </Select>
      )}
      {(target.secretNames ?? []).map((name) => {
        const h = held(name);
        return (
          <div key={name} className="flex flex-wrap items-end gap-2">
            <div className="min-w-48 flex-1">
              <TextInput
                label={name}
                type="password"
                autoComplete="off"
                value={values[name] ?? ''}
                placeholder={h ? 'set: type to replace' : 'not set on this workstation'}
                hint={h ? `Set ${formatDateTime(h.setAt)}` : undefined}
                data-testid={`secret-${name}`}
                onChange={(e) => setValues((cur) => ({ ...cur, [name]: e.target.value }))}
              />
            </div>
            <Button
              loading={set.isPending}
              disabled={!(values[name] ?? '') || !canSealHere()}
              data-testid={`secret-save-${name}`}
              onClick={() =>
                set.mutate(
                  { workstationId: ws, targetId: target.id, name, value: values[name] ?? '' },
                  {
                    onSuccess: () => {
                      setValues((cur) => ({ ...cur, [name]: '' }));
                      toast.success(`${name} sent to the workstation`);
                    },
                  },
                )
              }
            >
              Set {name}
            </Button>
          </div>
        );
      })}
      <ErrorBox error={set.error} />
    </div>
  );
}
