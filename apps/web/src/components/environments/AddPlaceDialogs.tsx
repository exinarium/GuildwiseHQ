import type { SetupStateDto } from '@aom/shared';
import { Server } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSetupState } from '../../api/queries/deploy-setup.ts';
import { useAddDeployTarget } from '../../api/queries/phases.ts';
import { type ConnectedServer, ConnectServer } from '../delivery/connect/ConnectServer.tsx';
import { Badge, Button, Callout, Dialog, ErrorBox, Spinner, TextInput } from '../ui.tsx';
import { CONNECTION_TEXT, nativeAppsFromReport, stacksFromReport } from './answers.ts';
import { checkedPlaces } from './FoundApps.tsx';
import { useProbeFlow } from './useProbeFlow.ts';

/**
 * Add a server (docs/design/environments-ux.md 5.3): choose a server this computer can already sign in to, or connect a new
 * one (the existing guided connect), then a short look at it. It makes a place and nothing else: no environment, no target
 * name to type. A place that is already there is not offered again.
 */
export function AddServerDialog({
  projectId,
  state,
  onClose,
  onAdded,
}: {
  projectId: string;
  state: SetupStateDto;
  onClose: () => void;
  onAdded: (placeId: string) => void;
}) {
  const live = useSetupState(projectId, true);
  const s = live.data ?? state;
  const usable = s.workstations.filter((w) => w.canProbe);
  const wsId = usable.find((w) => w.mine && w.connected)?.id ?? usable[0]?.id ?? '';
  const ws = s.workstations.find((w) => w.id === wsId);
  const flow = useProbeFlow(projectId, s.probes);
  const add = useAddDeployTarget(projectId);
  const [connecting, setConnecting] = useState<null | {
    name?: string;
    address?: string;
    user?: string;
    port?: number;
  }>(null);
  const [added, setAdded] = useState<{ id: string; alias: string } | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (wsId && !asked.current) {
      asked.current = true;
      flow.ask({ scope: 'ssh_hosts', workstationId: wsId });
    }
  }, [wsId, flow.ask]);

  const hostsProbe = s.probes.find((p) => p.scope === 'ssh_hosts' && p.workstationId === wsId);
  const used = new Set(s.targets.filter((t) => t.role !== 'retired').map((t) => t.host));
  const list = (hostsProbe?.report?.sshHosts ?? []).filter((h) => !used.has(h.alias));

  const chooseAlias = async (alias: string) => {
    try {
      const t = await add.mutateAsync({
        name: alias,
        kind: 'remote_ssh',
        workstationId: wsId,
        host: alias,
        notes: '',
        production: false,
      });
      setAdded({ id: t.id, alias });
      flow.ask({ scope: 'ssh_target', workstationId: wsId, host: alias });
    } catch {
      // shown below
    }
  };
  const connected = (c: ConnectedServer) => {
    setConnecting(null);
    setAdded({ id: c.targetId, alias: c.alias });
    flow.ask({ scope: 'ssh_target', workstationId: c.workstationId, host: c.alias });
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add a server"
      description="A server is one of your own servers that Guildwise can sign in to. Add it once, then choose it for any environment."
      size="lg"
    >
      <div className="flex flex-col gap-4" data-testid="add-server">
        {connecting && (
          <ConnectServer
            projectId={projectId}
            prefill={connecting}
            heading={false}
            onCancel={() => setConnecting(null)}
            onDone={connected}
          />
        )}
        {!connecting && !added && (
          <>
            {flow.loading && (
              <div
                className="flex items-center gap-2 text-sm text-muted"
                role="status"
                data-testid="probe-waiting"
              >
                <Spinner inline label="Looking" />
                Looking at the servers {ws?.name ?? 'this computer'} can sign in to...
              </div>
            )}
            {hostsProbe?.error && (
              <Callout tone="warning" title="Could not list the servers" data-testid="probe-error">
                {hostsProbe.errorText}
              </Callout>
            )}
            {list.length > 0 && (
              <div className="flex flex-col gap-2" data-testid="ssh-hosts">
                <p className="text-sm text-muted">
                  Servers {ws?.name ?? 'this computer'} already signs in to. Pick one to use it as it is.
                </p>
                {list.map((h) => {
                  const c = CONNECTION_TEXT[h.state];
                  return (
                    <div
                      key={h.alias}
                      className="flex flex-col gap-1 rounded-control border border-line p-3"
                      data-testid={`host-${h.alias}`}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Server aria-hidden="true" className="size-4 text-muted" />
                        <span className="font-medium text-fg">{h.alias}</span>
                        <Badge tone={c.tone}>{c.text}</Badge>
                      </div>
                      <p className="text-sm text-muted">
                        {h.hostname ?? ''}
                        {h.user ? `, user ${h.user}` : ''}
                        {h.state !== 'reachable' && h.detail ? `. ${h.detail}.` : ''}
                      </p>
                      {h.state === 'reachable' && (
                        <div>
                          <Button
                            size="sm"
                            variant="primary"
                            loading={add.isPending}
                            onClick={() => void chooseAlias(h.alias)}
                            data-testid={`host-use-${h.alias}`}
                          >
                            Use {h.alias}
                          </Button>
                        </div>
                      )}
                      {h.state === 'asks_password' && (
                        <div>
                          <Button
                            size="sm"
                            onClick={() =>
                              setConnecting({
                                name: h.alias,
                                ...(h.hostname ? { address: h.hostname } : {}),
                                ...(h.user ? { user: h.user } : {}),
                                ...(h.port ? { port: h.port } : {}),
                              })
                            }
                            data-testid={`host-connect-${h.alias}`}
                          >
                            Set up a sign-in for it
                          </Button>
                        </div>
                      )}
                      {h.state === 'host_key_changed' && (
                        <p className="text-sm text-danger">
                          The server's identity changed. This can mean it was reinstalled, or someone is in
                          between. Guildwise will not connect.
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {!flow.loading && hostsProbe?.report && list.length === 0 && (
              <Callout tone="info" title="No other server to pick" data-testid="no-hosts">
                Servers show up here when this computer already has a sign-in for them. Use{' '}
                <strong>Connect a new server</strong> to set up a sign-in with the address and the password
                your hosting company gave you.
              </Callout>
            )}
            <div>
              <Button onClick={() => setConnecting({})} data-testid="connect-different">
                Connect a new server
              </Button>
            </div>
            <ErrorBox error={add.error ?? flow.error} />
          </>
        )}
        {!connecting && added && (
          <ServerLook
            projectId={projectId}
            s={s}
            wsId={wsId}
            alias={added.alias}
            loading={flow.loading}
            onLookIn={(dir) =>
              flow.ask({
                scope: 'ssh_target',
                workstationId: wsId,
                host: added.alias,
                hints: { dirs: [dir], composeFiles: [`${dir}/docker-compose.yml`, `${dir}/compose.yaml`] },
              })
            }
            onDone={() => onAdded(added.id)}
          />
        )}
      </div>
    </Dialog>
  );
}

/** "Looking at the server": what is on it, or what was checked when nothing was found. */
function ServerLook({
  s,
  wsId,
  alias,
  loading,
  onLookIn,
  onDone,
}: {
  projectId: string;
  s: SetupStateDto;
  wsId: string;
  alias: string;
  loading: boolean;
  onLookIn: (dir: string) => void;
  onDone: () => void;
}) {
  const probe = s.probes.find(
    (p) => p.scope === 'ssh_target' && p.workstationId === wsId && p.host === alias,
  );
  const report = probe?.report ?? null;
  const stacks = useMemo(() => stacksFromReport(report), [report]);
  const natives = nativeAppsFromReport(report);
  const checked = checkedPlaces(report);
  const [dir, setDir] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-3" data-testid="server-look">
      <Callout tone="success" title={`${alias} is now one of your places`}>
        It can be chosen for any environment of this project.
      </Callout>
      {(loading || !probe) && (
        <div className="flex items-center gap-2 text-sm text-muted" role="status">
          <Spinner inline label="Looking" />
          Looking at {alias}. Nothing is changed.
        </div>
      )}
      {probe?.error && !loading && (
        <Callout tone="warning" title="Could not look at the server" data-testid="server-error">
          {probe.errorText}
        </Callout>
      )}
      {!loading && report && (
        <>
          {stacks.map((st) => (
            <p key={st.path} className="text-sm text-fg" data-testid="server-found">
              Found 1 app in{' '}
              <span className="font-mono text-xs">{st.path.slice(0, st.path.lastIndexOf('/'))}</span> (
              {st.services.length} {st.services.length === 1 ? 'part' : 'parts'}
              {st.running ? ', running' : ''}).
            </p>
          ))}
          {natives.map((a) => (
            <p key={`${a.manager}-${a.name}`} className="text-sm text-fg" data-testid="server-found-native">
              Found {a.name.replace(/\.service$/, '')} running directly on the server
              {a.workingDir ? ` in ${a.workingDir}` : ''}
              {a.ports[0] ? `, port ${a.ports[0]}` : ''}.
            </p>
          ))}
          {stacks.length === 0 && natives.length === 0 && (
            <Callout tone="info" title="We did not find a running app" data-testid="no-stacks">
              We looked in the usual places{checked.length ? ` (${checked.join(', ')})` : ''} and found no
              running app on {alias}. You can point us at the folder, or add the environment anyway and let
              Guildwise set the server up.
            </Callout>
          )}
          {!report.docker?.installed && (
            <p className="text-sm text-muted">
              Docker is not installed on {alias}. Guildwise can set it up when you add the environment.
            </p>
          )}
          {!open ? (
            <div>
              <Button size="sm" onClick={() => setOpen(true)} data-testid="server-other-folder">
                My app is in a different folder
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2 rounded-control border border-line p-3">
              <TextInput
                label={`Folder on ${alias}`}
                hint="The folder that holds docker-compose.yml."
                value={dir}
                placeholder="/home/you/dcode/app"
                autoCapitalize="none"
                onChange={(e) => setDir(e.target.value)}
                data-testid="server-folder-input"
              />
              <div>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!/^\/[A-Za-z0-9._/+@=-]*$/.test(dir.trim())}
                  onClick={() => onLookIn(dir.trim())}
                  data-testid="server-folder-look"
                >
                  Look there
                </Button>
              </div>
            </div>
          )}
        </>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={onDone} data-testid="server-done">
          Done
        </Button>
      </div>
    </div>
  );
}
