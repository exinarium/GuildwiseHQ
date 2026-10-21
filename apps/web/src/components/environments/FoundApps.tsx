import type { ProbeReport } from '@aom/shared';
import { Box, Cog, FolderSearch, PlayCircle, Search, Terminal } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Button, Callout, ErrorBox, Spinner, TextInput } from '../ui.tsx';
import { type NativeApp, nativeAppsFromReport, type Stack, stacksFromReport } from './answers.ts';
import { Choice } from './Choice.tsx';

export type StartChoice =
  | { kind: 'stack'; path: string }
  | { kind: 'native'; app: NativeApp }
  | { kind: 'typed' }
  | { kind: 'new' };

const NATIVE_KIND: Record<NativeApp['kind'], string> = {
  systemd: 'a system service',
  pm2: 'a pm2 process',
  process: 'a running program',
};

/** Where the look went, as a list a person can read ("/opt", "/srv", "/home/ada"). */
export function checkedPlaces(report: ProbeReport | null | undefined): string[] {
  const r = report as { checked?: string[] } | null | undefined;
  return [...new Set([...(r?.checked ?? []), ...(report?.folders ?? []).map((f) => f.path)])];
}

/**
 * "How is it started?" (docs/design/environments-ux.md journeys B and C): the apps the look found on the place (a Docker stack,
 * or an app that runs directly on the machine), "My app is somewhere else" with a folder, and, when there is nothing, what was
 * checked, never only "No app found".
 */
export function FoundApps({
  group,
  server,
  placeName,
  loading,
  error,
  errorText,
  report,
  selected,
  onSelect,
  onLookIn,
  onAgain,
  onScan,
  startNew,
  canStartNew,
}: {
  group: string;
  server: boolean;
  placeName: string;
  loading: boolean;
  error?: unknown;
  /** The look itself failed (Docker missing, the server did not answer). */
  errorText?: string | null | undefined;
  report: ProbeReport | null;
  selected: StartChoice | null;
  onSelect: (c: StartChoice) => void;
  onLookIn: (folder: string) => void;
  onAgain: () => void;
  onScan: () => void;
  /** The "start a new copy" form (shown when that row is picked). */
  startNew?: ReactNode;
  canStartNew: boolean;
}) {
  const [folderOpen, setFolderOpen] = useState(false);
  const [folder, setFolder] = useState('');
  const [lookedIn, setLookedIn] = useState('');
  const stacks: Stack[] = stacksFromReport(report);
  const natives = nativeAppsFromReport(report);
  const nothing = !!report && stacks.length === 0 && natives.length === 0;
  const checked = checkedPlaces(report);
  const folderOk = /^(\/|~\/)[A-Za-z0-9._/+@=-]*$/.test(folder.trim());

  return (
    <fieldset className="flex min-w-0 flex-col gap-2" data-testid="found-apps">
      <legend className="mb-1 text-sm font-medium text-fg">How is it started?</legend>
      {loading && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status" data-testid="probe-waiting">
          <Spinner inline label="Looking" />
          Looking on {placeName}. Nothing is changed.
        </div>
      )}
      <ErrorBox error={error} />
      {!loading && errorText && (
        <Callout
          tone="warning"
          title={`Could not look at ${placeName}`}
          data-testid="probe-error"
          actions={
            <Button size="sm" onClick={onAgain}>
              Check again
            </Button>
          }
        >
          {errorText}
        </Callout>
      )}
      {!loading && report && !errorText && (
        <>
          {(stacks.length > 0 || natives.length > 0) && (
            <p className="text-sm text-muted" data-testid="found-intro">
              Found on {placeName}. Guildwise uses the one you pick and leaves everything else as it is.
            </p>
          )}
          {stacks.map((st) => (
            <Choice
              key={st.path}
              name={group}
              checked={selected?.kind === 'stack' && selected.path === st.path}
              onSelect={() => onSelect({ kind: 'stack', path: st.path })}
              icon={<Box className="size-5" />}
              title={
                <>
                  The app that is already running here:{' '}
                  {st.project ?? st.path.split('/').slice(-2, -1)[0] ?? 'app'}{' '}
                  <span className="font-normal text-muted">(found)</span>
                </>
              }
              testId="stack-choice"
            >
              {st.services.length} {st.services.length === 1 ? 'part' : 'parts'} (
              {st.services.map((x) => x.name).join(', ')}).{' '}
              {st.running
                ? `Running now (${st.containers.filter((c) => c.state === 'running').length} of ${st.containers.length}).`
                : 'Not running.'}
              <span className="mt-0.5 block font-mono text-xs text-subtle [overflow-wrap:anywhere]">
                {st.path}
              </span>
            </Choice>
          ))}
          {natives.map((app) => (
            <Choice
              key={`${app.kind}-${app.name}-${app.folder}`}
              name={group}
              checked={selected?.kind === 'native' && selected.app === app}
              onSelect={() => onSelect({ kind: 'native', app })}
              icon={<Cog className="size-5" />}
              title={
                <>
                  Runs directly on this machine: {app.name}{' '}
                  <span className="font-normal text-muted">(found, not in Docker)</span>
                </>
              }
              testId="native-choice"
            >
              {NATIVE_KIND[app.kind][0]?.toUpperCase()}
              {NATIVE_KIND[app.kind].slice(1)}
              {app.port ? `, answers on port ${app.port}` : ''}
              {app.running ? '' : ', not running'}.
              {app.folder && (
                <span className="mt-0.5 block font-mono text-xs text-subtle [overflow-wrap:anywhere]">
                  {app.folder}
                </span>
              )}
            </Choice>
          ))}
          {nothing && (
            <Callout tone="info" title="We did not find a running app" data-testid="no-stacks">
              <p>
                We looked in the usual places{checked.length ? ` (${checked.join(', ')})` : ''}
                {lookedIn ? ` and in ${lookedIn}` : ''}, and found no running app on {placeName}.
              </p>
              <p className="mt-1">
                You can point us at the folder, start a new copy
                {canStartNew ? ' from your start steps' : ''}, type in an app that runs directly on the
                machine, or ask DevOps to look.
              </p>
            </Callout>
          )}
        </>
      )}

      {!loading && report && (
        <>
          <Choice
            name={group}
            checked={selected?.kind === 'typed'}
            onSelect={() => onSelect({ kind: 'typed' })}
            icon={<Terminal className="size-5" />}
            title="My app runs directly on this machine (not in Docker)"
            testId="native-typed"
          >
            A system service, a pm2 app or a program you start yourself. You tell us its name and folder.
          </Choice>
          {canStartNew && (
            <Choice
              name={group}
              checked={selected?.kind === 'new'}
              onSelect={() => onSelect({ kind: 'new' })}
              icon={<PlayCircle className="size-5" />}
              title="Start a new copy from my start steps"
              testId="new-copy"
            >
              Starts a fresh copy. What is running now is not touched.
            </Choice>
          )}
          {selected?.kind === 'new' && startNew}
          <div className="flex flex-col gap-2">
            {!folderOpen ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => setFolderOpen(true)} data-testid="somewhere-else">
                  <FolderSearch aria-hidden="true" className="size-4" />
                  {server ? 'My app is in a different folder' : 'My app is somewhere else'}
                </Button>
                <Button size="sm" variant="ghost" onClick={onAgain}>
                  Check again
                </Button>
                <Button size="sm" variant="ghost" onClick={onScan} data-testid="found-devops">
                  <Search aria-hidden="true" className="size-4" />
                  Let DevOps decide
                </Button>
              </div>
            ) : (
              <div
                className="flex flex-col gap-2 rounded-control border border-line p-3"
                data-testid="folder-form"
              >
                <TextInput
                  label={`Where is it? (folder on ${placeName})`}
                  hint="The folder that holds docker-compose.yml, for example /home/you/dcode/shop."
                  value={folder}
                  placeholder="/home/you/app"
                  autoCapitalize="none"
                  spellCheck={false}
                  onChange={(e) => setFolder(e.target.value)}
                  data-testid="folder-input"
                />
                <div className="flex gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={!folderOk}
                    onClick={() => {
                      setLookedIn(folder.trim());
                      onLookIn(folder.trim());
                    }}
                    data-testid="folder-look"
                  >
                    Look there
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setFolderOpen(false)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </fieldset>
  );
}
