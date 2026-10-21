import {
  describePrepareAction,
  type PrepareAction,
  type PrepareInputs,
  type PrepareStepResult,
  type ProbeReport,
  planPrepare,
} from '@aom/shared';
import { Eye, Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useOp, usePrepare } from '../../../api/queries/deploy-connect.ts';
import { Badge, Button, Callout, ErrorBox, Spinner, TextInput } from '../../ui.tsx';

const OUTCOME = {
  done: { text: 'Done', tone: 'green' },
  skipped: { text: 'Already there, kept', tone: 'neutral' },
  would: { text: 'Would do', tone: 'blue' },
  failed: { text: 'Did not work', tone: 'red' },
} as const;

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30) || 'app';

/**
 * Set up a server (or a new copy on this computer) that is not ready yet (docs/design/deploy-run-ux-design.md v2, J4 step 5):
 * Guildwise looked first, lists what is already there (kept as it is) and what it would add, tries it without changing
 * anything when asked, and only changes something after the person confirms the list. HTTPS is set up for the one domain
 * given, with Caddy; an existing proxy is adopted, never replaced.
 */
export function PrepareServer({
  projectId,
  hosting,
  workstationId,
  targetId,
  report,
  suggestedName,
  onPrepared,
}: {
  projectId: string;
  hosting: 'ssh' | 'this_computer';
  workstationId: string;
  /** The server target (ssh only). */
  targetId?: string | undefined;
  /** What the look at the server / this computer found (null: not looked yet). */
  report: ProbeReport | null;
  suggestedName: string;
  /** A real run finished without a failure: look again (with the compose file now in the folder). */
  onPrepared: (info: { dir: string; composeFile: string }) => void;
}) {
  const server = hosting === 'ssh';
  const base = slug(suggestedName);
  const [dir, setDir] = useState(server ? `/opt/${base}` : `~/guildwise/${base}`);
  const [domain, setDomain] = useState('');
  const [port, setPort] = useState('4600');
  const [composePath, setComposePath] = useState('docker-compose.yml');
  const [opId, setOpId] = useState<string | null>(null);
  const [wasDry, setWasDry] = useState(false);
  const prepare = usePrepare(projectId);
  const op = useOp(projectId, opId);

  const inputs: PrepareInputs = useMemo(
    () => ({
      hosting,
      appDir: dir.trim(),
      ...(server && domain.trim() ? { domain: domain.trim().toLowerCase(), upstreamPort: Number(port) } : {}),
      composeFromRepo: { repoPath: composePath.trim() },
      ...(server ? {} : { project: `aom-${base}`, appService: 'app' }),
    }),
    [hosting, dir, domain, port, composePath, server, base],
  );
  const plan = useMemo(() => planPrepare(report, inputs), [report, inputs]);
  const actions = plan.actions;
  const dirOk = server
    ? /^\/[A-Za-z0-9._/+@=-]+$/.test(dir.trim())
    : /^(~\/|\/)[A-Za-z0-9._/+@=-]+$/.test(dir.trim());
  const domainOk =
    !domain.trim() ||
    (/^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(domain.trim()) && Number(port) > 0 && Number(port) < 65536);
  const pathOk = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/.test(composePath.trim()) && !composePath.includes('..');
  const ready = dirOk && domainOk && pathOk && actions.length > 0 && plan.blockers.length === 0;
  const steps = (op.data?.result as { steps?: PrepareStepResult[] } | null)?.steps ?? [];
  const finished = op.data && op.data.state !== 'pending';
  const run = (dryRun: boolean) => {
    setWasDry(dryRun);
    prepare.mutate(
      {
        workstationId,
        ...(targetId ? { targetId } : {}),
        hosting,
        // the server computes the list again from these (and its own look at the server); `actions` is for an older server
        inputs,
        actions: actions as PrepareAction[],
        dryRun,
        confirmed: true,
      },
      { onSuccess: (r) => setOpId(r.commandId) },
    );
  };
  const succeeded = finished && op.data?.ok && !wasDry;
  const told = useRef<string | null>(null);
  useEffect(() => {
    if (succeeded && opId && told.current !== opId) {
      told.current = opId;
      onPrepared({ dir: dir.trim(), composeFile: `${dir.trim()}/docker-compose.yml` });
    }
  }, [succeeded, opId, onPrepared, dir]);

  return (
    <section
      className="flex flex-col gap-3 rounded-control border border-line p-3"
      data-testid="prepare-server"
    >
      <h4 className="text-base font-semibold text-fg">
        {server ? 'Set up this server' : 'Start a new copy on this computer'}
      </h4>
      <p className="text-sm text-muted">
        {server
          ? 'Guildwise looked at the server first. It only adds what is missing and keeps everything that is already there.'
          : 'Guildwise puts the project’s compose file in a folder of its own and starts the supporting parts (such as the database). Nothing that is already running is touched.'}
      </p>
      <TextInput
        label={server ? 'App folder on the server' : 'Folder for the new copy'}
        value={dir}
        onChange={(e) => setDir(e.target.value)}
        autoCapitalize="none"
        spellCheck={false}
        data-testid="prepare-dir"
      />
      <TextInput
        label="Compose file in the project"
        hint="Used only when the folder has none yet."
        value={composePath}
        onChange={(e) => setComposePath(e.target.value)}
        autoCapitalize="none"
        spellCheck={false}
        data-testid="prepare-compose"
      />
      {server && (
        <>
          <TextInput
            label="Web address for the site (optional)"
            hint="For example shop.example.com. Guildwise sets up HTTPS for this address only. Point the address to this server first."
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            autoCapitalize="none"
            spellCheck={false}
            data-testid="prepare-domain"
          />
          {domain.trim() && (
            <TextInput
              label="Port the app uses on the server"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              data-testid="prepare-port"
            />
          )}
        </>
      )}
      {plan.reuse.length > 0 && (
        <div data-testid="prepare-reuse">
          <p className="text-sm font-medium text-fg">Already there, kept as it is</p>
          <ul className="list-disc pl-5 text-sm text-muted">
            {plan.reuse.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {actions.length > 0 && (
        <div data-testid="prepare-actions">
          <p className="text-sm font-medium text-fg">Guildwise will</p>
          <ol className="list-decimal pl-5 text-sm text-muted">
            {actions.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the list has no ids
              <li key={i}>{describePrepareAction(a, server ? 'server' : 'computer')}</li>
            ))}
          </ol>
        </div>
      )}
      {actions.length === 0 && plan.blockers.length === 0 && report && (
        <p className="text-sm text-success" data-testid="prepare-nothing">
          Nothing to set up: everything is already there.
        </p>
      )}
      {plan.blockers.length > 0 && (
        <Callout tone="warning" title="Needs a person first" data-testid="prepare-blockers">
          <ul className="list-disc pl-4">
            {plan.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </Callout>
      )}
      {opId && op.data?.state === 'pending' && (
        <div
          className="flex items-center gap-2 text-sm text-muted"
          role="status"
          data-testid="prepare-working"
        >
          <Spinner inline label="Working" />
          {wasDry
            ? 'Trying it without changing anything...'
            : 'Setting it up (installing can take a few minutes)...'}
        </div>
      )}
      {finished && (
        <div data-testid="prepare-result" className="flex flex-col gap-2">
          <ul className="flex flex-col gap-1">
            {steps.map((s, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: steps have no ids
              <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone={OUTCOME[s.outcome].tone}>{OUTCOME[s.outcome].text}</Badge>
                <span className="text-muted">{s.detail}</span>
              </li>
            ))}
          </ul>
          {!op.data?.ok && (
            <Callout tone="danger" title="It stopped" data-testid="prepare-error">
              {op.data?.errorText}
            </Callout>
          )}
          {succeeded && (
            <Callout tone="success" title="Done" data-testid="prepare-done">
              The {server ? 'server' : 'copy'} is ready. Guildwise looks again so you can pick the app.
            </Callout>
          )}
          {op.data?.ok && wasDry && (
            <p className="text-sm text-muted">Nothing was changed. Press “Set it up” to do it for real.</p>
          )}
        </div>
      )}
      <ErrorBox error={prepare.error} />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button
          onClick={() => run(true)}
          disabled={!ready || prepare.isPending || op.data?.state === 'pending'}
          data-testid="prepare-dry"
        >
          <Eye aria-hidden="true" className="size-4" />
          Try it without changing anything
        </Button>
        <Button
          variant="primary"
          onClick={() => run(false)}
          disabled={!ready || prepare.isPending || op.data?.state === 'pending'}
          loading={prepare.isPending}
          data-testid="prepare-run"
        >
          <Wrench aria-hidden="true" className="size-4" />
          Set it up
        </Button>
        {succeeded && (
          <Button
            variant="ghost"
            onClick={() => onPrepared({ dir: dir.trim(), composeFile: `${dir.trim()}/docker-compose.yml` })}
            data-testid="prepare-again"
          >
            Look again
          </Button>
        )}
      </div>
    </section>
  );
}
