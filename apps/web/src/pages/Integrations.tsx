import {
  INTEGRATION_KINDS,
  type IntegrationKind,
  type IntegrationStatus,
  integrationKind,
} from '@aom/shared';
import { useEffect, useState } from 'react';
import { Navigate, useParams, useSearchParams } from 'react-router';
import { useMe } from '../api/queries/auth.ts';
import { useIntegrationWorkstations, useWorkstationIntegrations } from '../api/queries/integrations.ts';
import { AiRuntimeSection } from '../components/integrations/AiRuntimeSection.tsx';
import { ConnectDialog } from '../components/integrations/ConnectDialog.tsx';
import { IntegrationTile } from '../components/integrations/IntegrationTile.tsx';
import { McpSignInList } from '../components/integrations/McpSignInList.tsx';
import { WorkstationChooser } from '../components/integrations/WorkstationChooser.tsx';
import {
  Button,
  Callout,
  ConnectionDot,
  EmptyState,
  ErrorBox,
  ListSkeleton,
  PageHeader,
} from '../components/ui.tsx';
import {
  GROUPS,
  type PageCtx,
  parseFocus,
  readLastWorkstation,
  runnerCanWeb,
  writeLastWorkstation,
} from '../lib/integrations.ts';

/** `/integrations`: the one workstation goes straight to its page; with several, a chooser (the last choice remembered). */
export function IntegrationsIndex() {
  const list = useIntegrationWorkstations();
  const me = useMe();
  const [sp] = useSearchParams();
  const userId = me.data?.user.id;
  const search = sp.toString() ? `?${sp.toString()}` : '';
  if (list.isPending || me.isPending) return <ListSkeleton rows={2} />;
  if (list.error) return <ErrorBox error={list.error} onRetry={() => void list.refetch()} />;
  const all = list.data?.workstations ?? [];
  if (all.length === 0)
    return (
      <>
        <PageHeader title="Integrations" />
        <EmptyState
          title="No workstation yet"
          description="Add a workstation first; its integrations are managed here."
        />
      </>
    );
  const last = readLastWorkstation(userId);
  const lastKnown = all.find((w) => w.id === last);
  const only = all.length === 1 ? all[0] : null;
  // A deep link (?focus=) with several workstations goes to the last one used when there is one.
  const target = only ?? (sp.get('focus') ? lastKnown : undefined);
  if (target) return <Navigate to={`/workstations/${target.id}/integrations${search}`} replace />;
  return (
    <>
      <PageHeader
        title="Integrations"
        sub="Choose the workstation whose logins and tokens you want to manage."
      />
      <WorkstationChooser
        workstations={all}
        lastId={lastKnown?.id ?? null}
        search={search}
        onChoose={(id) => writeLastWorkstation(userId, id)}
      />
    </>
  );
}

function KeyLine({ keyId, name }: { keyId: string | null; name: string }) {
  if (!keyId)
    return (
      <p className="text-sm text-muted" data-testid="key-line">
        {name} has not announced its encryption key yet, so secrets cannot be sent from here.
      </p>
    );
  return (
    <p className="text-sm text-muted" data-testid="key-line">
      Secrets are encrypted in this browser for this workstation, key{' '}
      <code className="font-mono text-xs">{keyId}</code>.{' '}
      <code className="font-mono text-xs">aom-runner doctor</code> shows the same id.
    </p>
  );
}

function instancesOf(
  kind: IntegrationKind,
  statuses: IntegrationStatus[],
): Array<IntegrationStatus | { instance: string }> {
  const mine = statuses.filter((s) => s.kind === kind.id);
  if (mine.length > 0) return mine;
  const def = typeof kind.instances === 'object' ? (kind.instances.defaultInstance ?? '') : '';
  return [{ instance: def }];
}

function ConnectAnother({ ctx, kind }: { ctx: PageCtx; kind: IntegrationKind }) {
  const [open, setOpen] = useState(false);
  if (typeof kind.instances !== 'object') return null;
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setOpen(true)}
        data-testid={`connect-another-${kind.id}`}
      >
        Connect another {kind.instances.label.toLowerCase()}
      </Button>
      {open && <ConnectDialog open={open} onOpenChange={setOpen} ctx={ctx} kind={kind} instance={null} />}
    </>
  );
}

/** `/workstations/:id/integrations`: every integration of one workstation, grouped. */
export function Integrations() {
  const { id } = useParams();
  const q = useWorkstationIntegrations(id);
  const me = useMe();
  const [sp] = useSearchParams();
  const focus = parseFocus(sp.get('focus'));
  const connectLink = sp.get('connect') === '1';
  const userId = me.data?.user.id;

  useEffect(() => {
    if (id && q.data) writeLastWorkstation(userId, id);
  }, [id, userId, q.data]);
  useEffect(() => {
    if (focus?.kind === 'mcp' && !focus.instance && q.data)
      document.getElementById('group-mcp')?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
  }, [focus?.kind, focus?.instance, q.data]);

  if (q.isPending) return <ListSkeleton rows={4} />;
  if (q.error)
    return (
      <>
        <PageHeader title="Integrations" back={{ to: '/workstations', label: 'Workstations' }} />
        <ErrorBox error={q.error} onRetry={() => void q.refetch()} />
      </>
    );
  const page = q.data;
  const ctx: PageCtx = { workstationId: page.workstation.id, workstationName: page.workstation.name, page };
  const old = page.legacy || page.runner.integrationsVersion === null;
  const minRunner = INTEGRATION_KINDS[0]?.minRunner ?? '';
  const offline = !page.runner.connected;

  return (
    <>
      <PageHeader
        title={`Integrations on ${page.workstation.name}`}
        back={{ to: '/workstations', label: 'Workstations' }}
        sub={
          <span className="flex flex-wrap items-center gap-3">
            <ConnectionDot
              connected={page.runner.connected}
              label={page.runner.connected ? 'Online' : 'Offline'}
            />
            <span data-testid="runner-version">
              {page.runner.version ? `runner ${page.runner.version}` : 'runner version unknown'}
            </span>
          </span>
        }
      />
      <div className="mb-4 flex flex-col gap-3">
        <KeyLine keyId={page.key?.keyId ?? null} name={page.workstation.name} />
        {old && (
          <Callout tone="warning" data-testid="old-runner-banner">
            Update to runner &gt;= {minRunner} to connect from here; until then run the command shown under
            &ldquo;From a terminal&rdquo; on each tile. The states below are read-only.
          </Callout>
        )}
        {!old && page.runner.policy && !page.runner.policy.allowWeb && (
          <Callout tone="info" data-testid="web-off-banner">
            Turned off on this workstation (aom-runner integrations allow-web on)
          </Callout>
        )}
        {offline && !old && (
          <Callout tone="info">
            {page.workstation.name} is offline. You can read the last known state only.
          </Callout>
        )}
      </div>

      <div className="flex flex-col gap-8">
        {GROUPS.map((g) => (
          <section
            key={g.id}
            id={`group-${g.id}`}
            aria-labelledby={`h-${g.id}`}
            data-testid={`group-${g.id}`}
          >
            <h2 id={`h-${g.id}`} className="mb-3 text-lg font-semibold text-fg">
              {g.title}
            </h2>
            <div className="flex flex-col gap-3">
              {g.kinds.map((kid) => {
                const kind = integrationKind(kid);
                if (!kind) return null;
                if (kind.id === 'mcp')
                  return (
                    <McpSignInList
                      key={kid}
                      ctx={ctx}
                      kind={kind}
                      statuses={page.integrations.filter((s) => s.kind === 'mcp')}
                      focusInstance={focus?.kind === 'mcp' ? focus.instance || null : null}
                      openConnect={connectLink}
                    />
                  );
                const rows = instancesOf(kind, page.integrations);
                return (
                  <div key={kid} className="flex flex-col gap-2">
                    {rows.map((r) => {
                      const status = 'kind' in r ? r : undefined;
                      const isFocus =
                        focus?.kind === kid &&
                        (focus.instance === r.instance ||
                          (!focus.instance && rows.length >= 1 && r === rows[0]));
                      return (
                        <IntegrationTile
                          key={r.instance}
                          ctx={ctx}
                          kind={kind}
                          instance={r.instance}
                          status={status}
                          highlight={isFocus}
                          openConnect={isFocus && connectLink}
                        />
                      );
                    })}
                    {typeof kind.instances === 'object' && kind.id !== 'ssh' && runnerCanWeb(page, kind) && (
                      <div>
                        <ConnectAnother ctx={ctx} kind={kind} />
                      </div>
                    )}
                  </div>
                );
              })}
              {g.id === 'ai' && <AiRuntimeSection ctx={ctx} focus={focus} openConnect={connectLink} />}
            </div>
          </section>
        ))}
      </div>
    </>
  );
}
