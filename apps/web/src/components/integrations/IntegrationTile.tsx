import {
  INTEGRATION_STATE_LABELS,
  type IntegrationKind,
  type IntegrationState,
  type IntegrationStatus,
  integrationCli,
  integrationScope,
} from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  integrationErrorMessage,
  isRequestTerminal,
  useIntegrationRequest,
  useRemoveIntegration,
  useTestIntegration,
} from '../../api/queries/integrations.ts';
import { blockReason, daysUntil, type PageCtx, scopeOf, tileId } from '../../lib/integrations.ts';
import { copyText } from '../../lib/secure.ts';
import { formatDateTime } from '../../lib/time.ts';
import { Badge, Button, ConfirmDialog, ErrorBox, useToast } from '../ui.tsx';
import { ConnectDialog, MethodSteps } from './ConnectDialog.tsx';

const TONE: Record<IntegrationState, 'green' | 'neutral' | 'amber' | 'red'> = {
  connected: 'green',
  not_connected: 'neutral',
  refused: 'red',
  expired: 'red',
  needs_sign_in: 'amber',
  unreachable: 'amber',
  unavailable: 'neutral',
  not_needed: 'neutral',
};

/** One integration (or one instance of it) with its facts, actions and set-up help. */
export function IntegrationTile({
  ctx,
  kind,
  instance,
  status,
  highlight = false,
  openConnect = false,
  title,
}: {
  ctx: PageCtx;
  kind: IntegrationKind;
  instance: string;
  status?: IntegrationStatus | undefined;
  highlight?: boolean;
  /** Deep link `connect=1`: open the Connect dialog on arrival. */
  openConnect?: boolean;
  /** Overrides the heading (an MCP row names its server). */
  title?: string;
}) {
  const toast = useToast();
  const ref = useRef<HTMLElement>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [actionKind, setActionKind] = useState<'test' | 'remove'>('test');
  const test = useTestIntegration(ctx.workstationId);
  const remove = useRemoveIntegration(ctx.workstationId);
  const action = useIntegrationRequest(ctx.workstationId, actionId);

  const state: IntegrationState = status?.state ?? 'not_connected';
  const scope = scopeOf(kind, status);
  const isMcp = kind.id === 'mcp';
  const isSsh = kind.id === 'ssh';
  const connected = state === 'connected';
  const signedIn = isMcp && connected;
  const interactiveMethod = kind.methods.find((m) => m.flow === 'interactive' && !m.phase);
  const hasConnect = kind.methods.some(
    (m) => m.flow !== 'local_only' && !m.phase && (m.id !== 'claude_login' || instance !== ''),
  );
  const pending = ctx.page.activeSessions.find(
    (s) => s.kind === kind.id && s.instance === instance && !isRequestTerminal(s.state),
  );
  const block = blockReason(ctx, kind, scope, instance);
  const cli = integrationCli(
    kind,
    instance || (typeof kind.instances === 'object' ? (kind.instances.defaultInstance ?? '') : ''),
  );

  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  }, [highlight]);
  useEffect(() => {
    if (openConnect && hasConnect && !block) setConnectOpen(true);
  }, [openConnect, hasConnect, block]);

  const run = (what: 'test' | 'remove') => {
    const body = { requestId: crypto.randomUUID(), kind: kind.id, instance };
    const m = what === 'test' ? test : remove;
    setActionKind(what);
    m.mutate(body, { onSuccess: (r) => setActionId(r.id) });
  };

  const exp = status?.expiresAt;
  const days = exp ? daysUntil(exp) : null;
  const missing = new Set(status?.missingScopes ?? []);
  const scopes = [...new Set([...(status?.scopes ?? []), ...missing])];
  const heading = title ?? (instance && !isMcp ? `${kind.label} (${instance})` : kind.label);
  const actionBusy = !!actionId && !isRequestTerminal(action.data?.state);
  const actionError = test.error ?? remove.error;

  const disabledBtn = (
    label: string,
    onClick: () => void,
    opts?: { variant?: 'primary' | 'secondary' | 'danger-ghost' },
  ) => (
    <Button
      size="sm"
      variant={opts?.variant ?? 'secondary'}
      disabled={!!block || actionBusy}
      title={block ?? undefined}
      onClick={onClick}
    >
      {label}
    </Button>
  );

  return (
    <article
      ref={ref}
      id={tileId(kind.id, instance)}
      data-testid={tileId(kind.id, instance)}
      data-state={state}
      data-highlight={highlight ? 'true' : undefined}
      className={`rounded-card border bg-surface p-4 ${highlight ? 'border-brand ring-2 ring-ring/40' : 'border-line'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-fg">{heading}</h3>
        {kind.id === 'claude-code' && instance === '' && (
          <span className="text-xs text-subtle" data-testid="tile-main-account">
            Main account
          </span>
        )}
        <Badge tone={TONE[state]} data-testid="tile-badge">
          {signedIn ? 'Signed in' : INTEGRATION_STATE_LABELS[state]}
        </Badge>
        {scope === 'machine' && (
          <span className="text-xs text-subtle" data-testid="tile-scope-note">
            Shared by every pairing on this machine
          </span>
        )}
      </div>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm" data-testid="tile-facts">
        {status?.account && (
          <>
            <dt className="text-subtle">Account</dt>
            <dd>{status.account}</dd>
          </>
        )}
        {status?.method && (
          <>
            <dt className="text-subtle">Method</dt>
            <dd>{kind.methods.find((m) => m.id === status.method)?.label ?? status.method}</dd>
          </>
        )}
        {status?.site && (
          <>
            <dt className="text-subtle">Site</dt>
            <dd className="break-all">{status.site}</dd>
          </>
        )}
        {scopes.length > 0 && (
          <>
            <dt className="text-subtle">Scopes</dt>
            <dd className="flex flex-wrap gap-1" data-testid="tile-scopes">
              {scopes.map((s) => (
                <code
                  key={s}
                  className={`rounded px-1.5 font-mono text-xs ${
                    missing.has(s) ? 'bg-warning-soft text-warning-soft-fg' : 'bg-sunken'
                  }`}
                  data-missing={missing.has(s) ? 'true' : undefined}
                  title={missing.has(s) ? 'Missing: add this scope to the token' : undefined}
                >
                  {s}
                  {missing.has(s) ? ' (missing)' : ''}
                </code>
              ))}
            </dd>
          </>
        )}
        {exp && days !== null && (
          <>
            <dt className="text-subtle">Expires</dt>
            <dd
              data-testid="tile-expiry"
              className={days < 14 ? 'font-medium text-danger' : undefined}
              title={formatDateTime(exp)}
            >
              {days < 0 ? 'expired' : days === 0 ? 'today' : `in ${days} ${days === 1 ? 'day' : 'days'}`}
            </dd>
          </>
        )}
        {status && (
          <>
            <dt className="text-subtle">Last checked</dt>
            <dd>{formatDateTime(status.checkedAt)}</dd>
          </>
        )}
      </dl>
      {status?.detail && state !== 'connected' && (
        <p className="mt-2 text-sm text-muted" data-testid="tile-detail">
          {status.detail}
        </p>
      )}
      {isSsh && status?.publicKey && (
        <div className="mt-2 text-sm" data-testid="tile-public-key">
          <p className="text-xs text-subtle">Public key (add it on the git host)</p>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 rounded bg-sunken p-2 font-mono text-xs break-all">
              {status.publicKey}
            </code>
            <Button
              size="sm"
              onClick={async () => {
                if (await copyText(status.publicKey ?? '')) toast.success('Public key copied');
              }}
            >
              Copy
            </Button>
          </div>
        </div>
      )}
      {isSsh && (
        <p className="mt-2 text-sm">
          <Link to="/workstations" className="text-brand-text underline" data-testid="ssh-manage">
            Manage SSH keys on the Workstations page (Git hosts)
          </Link>
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="tile-actions">
        {hasConnect &&
          (pending ? (
            disabledBtn('Continue sign-in', () => setConnectOpen(true), { variant: 'primary' })
          ) : isMcp ? (
            <>
              {disabledBtn(signedIn ? 'Sign in again' : 'Sign in', () => setConnectOpen(true), {
                variant: signedIn ? 'secondary' : 'primary',
              })}
              {signedIn && disabledBtn('Sign out', () => setRemoveOpen(true), { variant: 'danger-ghost' })}
            </>
          ) : (
            disabledBtn(connected ? 'Replace' : 'Connect', () => setConnectOpen(true), {
              variant: connected ? 'secondary' : 'primary',
            })
          ))}
        {status && state !== 'not_connected' && disabledBtn('Test', () => run('test'))}
        {!isMcp &&
          connected &&
          !isSsh &&
          disabledBtn('Remove', () => setRemoveOpen(true), { variant: 'danger-ghost' })}
        {actionBusy && <span className="text-xs text-subtle">Checking with {kind.label}...</span>}
      </div>
      {block && (
        <p className="mt-2 text-xs text-muted" data-testid="tile-blocked">
          {block}
        </p>
      )}
      {action.data && isRequestTerminal(action.data.state) && (
        <p
          className={`mt-2 text-sm ${action.data.state === 'done' ? 'text-muted' : 'text-danger'}`}
          role="status"
          data-testid="tile-action-result"
        >
          {action.data.state === 'done'
            ? action.data.status?.detail ||
              (actionKind === 'remove'
                ? 'Removed.'
                : `Checked: ${INTEGRATION_STATE_LABELS[action.data.status?.state ?? state].toLowerCase()}.`)
            : (action.data.error ?? `${actionKind === 'remove' ? 'Remove' : 'Test'} failed.`)}
        </p>
      )}
      <ErrorBox error={actionError ? new Error(integrationErrorMessage(actionError)) : null} />

      <details className="mt-3 text-sm" data-testid="tile-setup">
        <summary className="cursor-pointer font-medium text-muted hover:text-fg">How to set it up</summary>
        <div className="mt-2 flex flex-col gap-3">
          <p className="text-muted">{kind.help.summary}</p>
          {kind.methods
            .filter((m) => m.id !== 'claude_login' || instance !== '')
            .map((m) => (
              <div key={m.id}>
                <p className="mb-1 font-medium text-fg">
                  {m.label}
                  {m.phase ? ' (later)' : ''}
                </p>
                <MethodSteps method={m} />
                {m.warning && <p className="mt-1 text-xs text-subtle">{m.warning}</p>}
              </div>
            ))}
          <p className="text-xs text-subtle">
            Test: {kind.test.what} Stored: {kind.storage}
          </p>
          {kind.help.notes?.map((n) => (
            <p key={n} className="text-xs text-subtle">
              {n}
            </p>
          ))}
        </div>
      </details>
      <details className="mt-2 text-sm" data-testid="tile-terminal">
        <summary className="cursor-pointer font-medium text-muted hover:text-fg">From a terminal</summary>
        <div className="mt-2 flex items-center gap-2">
          <code className="rounded bg-sunken px-2 py-1 font-mono text-xs break-all">{cli}</code>
          <Button
            size="sm"
            onClick={async () => {
              if (await copyText(cli)) toast.success('Command copied');
            }}
          >
            Copy
          </Button>
        </div>
        <p className="mt-1 text-xs text-subtle">
          Run it on {ctx.workstationName}. This page updates within a few seconds.
        </p>
      </details>

      {hasConnect && (
        <ConnectDialog
          open={connectOpen}
          onOpenChange={setConnectOpen}
          ctx={ctx}
          kind={kind}
          instance={
            kind.instances !== 'single' && instance === '' && kind.id !== 'claude-code' ? null : instance
          }
          initialMethod={isMcp ? interactiveMethod?.id : undefined}
          resumeSessionId={pending?.id}
        />
      )}
      <ConfirmDialog
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={isMcp ? `Sign out of ${title ?? instance}?` : `Remove ${heading}?`}
        description={`This deletes ${isMcp ? 'the sign-in' : 'the saved credential'} on ${ctx.workstationName}: ${kind.storage}${
          (integrationScope(kind, status?.method) === 'machine' || scope === 'machine') &&
          !/shared by every pairing/i.test(kind.storage) // said once, not twice (some stores already say it)
            ? ' It is shared by every pairing on this machine.'
            : ''
        }`}
        confirmLabel={isMcp ? 'Sign out' : 'Remove'}
        pending={remove.isPending}
        onConfirm={() => {
          setRemoveOpen(false);
          run('remove');
        }}
      />
    </article>
  );
}
