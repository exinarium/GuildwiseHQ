import {
  type AccountScope,
  type AiRuntimeAccount,
  type AiRuntimeTile,
  accountScopeDef,
  backendDef,
  integrationKind,
  isKeyScope,
  ProviderAccountKeySchema,
  type ProviderKeyId,
} from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAiRuntimes, usePromoteAccount } from '../../api/queries/ai-runtimes.ts';
import { useRemoveIntegration } from '../../api/queries/integrations.ts';
import { useRemoveProviderKey, useSetProviderKey } from '../../api/queries/providers.ts';
import type { PageCtx } from '../../lib/integrations.ts';
import { canSealHere, newId } from '../../lib/secure.ts';
import {
  type CredentialDraft,
  CredentialFields,
  draftProblem,
  emptyDraft,
  parseModelIds,
  secretOf,
} from '../providers/CredentialFields.tsx';
import { SecureContextNotice } from '../SecureContextNotice.tsx';
import { formatUntil } from '../UsageLimitBanner.tsx';
import { Badge, Button, Callout, ConfirmDialog, Dialog, ErrorBox, TextInput, useToast } from '../ui.tsx';
import { ConnectDialog } from './ConnectDialog.tsx';

const MAIN = 'main';

/** The status line of one account row, in words: login accounts say signed in or not, key accounts say whose key. */
export function accountStatus(a: AiRuntimeAccount): {
  tone: 'green' | 'red' | 'amber' | 'neutral';
  text: string;
} {
  if (a.kind === 'login') {
    if (a.state === 'expired') return { tone: 'red', text: 'Sign-in expired' };
    if (a.state === 'none') return { tone: 'amber', text: 'Not signed in' };
    if (a.usage === 'limited')
      return {
        tone: 'amber',
        text: `Usage limit until ${a.limitedUntil ? formatUntil(a.limitedUntil) : 'later'}`,
      };
    return { tone: 'green', text: 'Signed in' };
  }
  if (a.state === 'none') return { tone: 'neutral', text: 'No key' };
  if (a.source === 'org') return { tone: 'green', text: 'Organization key in effect' };
  return { tone: 'green', text: a.main && a.orgKey ? 'Own key (overrides the organization’s)' : 'Key set' };
}

/** A key (or credentials) for one account of one provider, sealed in the browser for this workstation's runner. */
function ProviderKeyDialog({
  open,
  onOpenChange,
  workstationId,
  workstationName,
  provider,
  label,
  account,
  existing,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workstationId: string;
  workstationName: string;
  provider: ProviderKeyId;
  label: string;
  /** The account name; `null` asks for it (a new named account); `main` is the main key. */
  account: string | null;
  existing: boolean;
}) {
  const set = useSetProviderKey(workstationId);
  const toast = useToast();
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<CredentialDraft>(emptyDraft());
  const { reset } = set;
  useEffect(() => {
    if (!open) {
      setDraft(emptyDraft());
      setName('');
      reset();
    }
  }, [open, reset]);
  const asking = account === null;
  const acct = asking ? name.trim() : account === MAIN ? undefined : account;
  const nameProblem =
    asking && name.trim() !== '' && !ProviderAccountKeySchema.safeParse(name.trim()).success
      ? 'Use lowercase letters, digits and dashes, starting with a letter (up to 32), and not "main" or "org"'
      : asking && name.trim() === ''
        ? 'Name the account'
        : null;
  const problem = nameProblem ?? draftProblem(provider, draft);
  const isBackend = backendDef(provider) !== undefined;
  const save = () =>
    set.mutate(
      {
        provider,
        key: secretOf(provider, draft),
        ...(isBackend ? {} : { baseUrl: draft.baseUrl.trim() }),
        models: parseModelIds(draft.models),
        ...(acct ? { account: acct } : {}),
      },
      {
        onSuccess: () => {
          onOpenChange(false);
          toast.success(`${label}${acct ? ` (${acct})` : ''} sent to ${workstationName}`);
        },
      },
    );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        asking
          ? `Add a named ${label} account`
          : `${existing ? 'Replace' : 'Set'} the ${label} key${acct ? ` of ${acct}` : ' (main account)'}`
      }
      description="The key is encrypted in this browser for the runner of this workstation and kept only there."
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={set.isPending}
            disabled={!!problem || !canSealHere()}
            title={problem ?? undefined}
            data-testid="ai-key-save"
            onClick={save}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <SecureContextNotice />
        {asking && (
          <TextInput
            label="Account name"
            placeholder="work"
            value={name}
            autoComplete="off"
            error={nameProblem && name.trim() !== '' ? nameProblem : undefined}
            hint="A short name, the same on every workstation. A project picks the account by this name."
            data-testid="ai-key-name"
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <CredentialFields id={provider} draft={draft} onChange={setDraft} testPrefix="ai-key" />
        <ErrorBox error={set.error} />
      </div>
    </Dialog>
  );
}

function AccountRow({
  tile,
  a,
  ctx,
  blocked,
  focused,
  openOnArrival,
}: {
  tile: AiRuntimeTile;
  a: AiRuntimeAccount;
  ctx: PageCtx;
  /** Why the actions are off now (or null). */
  blocked: string | null;
  focused: boolean;
  openOnArrival: boolean;
}) {
  const toast = useToast();
  const scope = tile.id as AccountScope;
  const kind = tile.integrationKind ? integrationKind(tile.integrationKind) : undefined;
  const [signIn, setSignIn] = useState(false);
  const [key, setKey] = useState(false);
  const [remove, setRemove] = useState(false);
  const [promote, setPromote] = useState(false);
  const removeKey = useRemoveProviderKey(ctx.workstationId);
  const removeLogin = useRemoveIntegration(ctx.workstationId);
  const promoteM = usePromoteAccount(ctx.workstationId);
  const st = accountStatus(a);
  const name = a.main ? 'Main account' : a.key;
  const id = `${tile.id}-${a.key}`;
  const login = a.kind === 'login';
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    if (focused && openOnArrival && !blocked) (login ? setSignIn : setKey)(true);
  }, [focused, openOnArrival, blocked, login]);
  const btn = (
    label: string,
    onClick: () => void,
    testId: string,
    variant: 'secondary' | 'primary' | 'danger-ghost' = 'secondary',
  ) => (
    <Button
      size="sm"
      variant={variant}
      disabled={!!blocked}
      title={blocked ?? undefined}
      data-testid={testId}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  return (
    <li
      ref={ref}
      data-testid={`ai-account-${id}`}
      data-focus={focused ? 'true' : undefined}
      className={`rounded-control border bg-canvas p-2 text-sm ${focused ? 'border-brand' : 'border-line'}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{name}</span>
        <Badge tone={st.tone} data-testid={`ai-status-${id}`}>
          {st.text}
        </Badge>
        {a.email && <span className="text-xs text-muted">{a.email}</span>}
        {!login && a.state === 'ok' && a.source === 'workstation' && a.main && !a.orgKey && (
          <span className="text-xs text-subtle">Not capped</span>
        )}
      </div>
      {a.detail && a.state !== 'ok' && <p className="mt-1 text-xs text-muted">{a.detail}</p>}
      <div className="mt-1.5 flex flex-wrap gap-2">
        {login &&
          btn(
            a.state === 'ok' ? 'Sign in again' : 'Sign in',
            () => setSignIn(true),
            `ai-signin-${id}`,
            a.state === 'ok' ? 'secondary' : 'primary',
          )}
        {!login &&
          !(a.main && a.source === 'org') &&
          btn(
            a.state === 'ok' ? 'Replace key' : 'Set key',
            () => setKey(true),
            `ai-setkey-${id}`,
            a.state === 'ok' ? 'secondary' : 'primary',
          )}
        {a.canPromote && btn('Make main', () => setPromote(true), `ai-promote-${id}`)}
        {!a.main && btn('Remove', () => setRemove(true), `ai-remove-${id}`, 'danger-ghost')}
        {!login &&
          a.main &&
          a.state === 'ok' &&
          a.source === 'workstation' &&
          btn('Remove', () => setRemove(true), `ai-remove-${id}`, 'danger-ghost')}
      </div>
      {login && kind && (
        <ConnectDialog
          open={signIn}
          onOpenChange={setSignIn}
          ctx={ctx}
          kind={kind}
          instance={a.main ? '' : a.key}
        />
      )}
      {!login && isKeyScope(scope) && (
        <ProviderKeyDialog
          open={key}
          onOpenChange={setKey}
          workstationId={ctx.workstationId}
          workstationName={ctx.workstationName}
          provider={scope}
          label={tile.label}
          account={a.main ? MAIN : a.key}
          existing={a.state === 'ok'}
        />
      )}
      <ConfirmDialog
        open={remove}
        onOpenChange={setRemove}
        title={`Remove ${a.main ? 'the main key' : `account ${a.key}`} of ${tile.label}?`}
        description={
          login
            ? `This unregisters the account on ${ctx.workstationName} and deletes the login Guildwise stored for it. Projects that name it wait or use the main account.`
            : `This deletes the key on ${ctx.workstationName}. Projects that name it wait or use the main account.`
        }
        confirmLabel="Remove"
        pending={removeKey.isPending || removeLogin.isPending}
        onConfirm={() => {
          setRemove(false);
          const done = () => toast.success(`${name} of ${tile.label} removed`);
          if (login)
            removeLogin.mutate(
              { requestId: newId(), kind: tile.id as never, instance: a.key },
              { onSuccess: done },
            );
          else
            removeKey.mutate(
              { provider: scope as ProviderKeyId, ...(a.main ? {} : { account: a.key }) },
              { onSuccess: done },
            );
        }}
      />
      <ConfirmDialog
        open={promote}
        onOpenChange={setPromote}
        title={`Make ${a.key} the main ${tile.label} account?`}
        description={`${a.key} takes the place of the main account and the main account becomes ${a.key}: nothing is lost, and doing it again undoes it. Work that uses the main account (the CEO, DevOps, chats, projects without an account) moves with it.`}
        confirmLabel="Make main"
        tone="primary"
        pending={promoteM.isPending}
        onConfirm={() => {
          setPromote(false);
          promoteM.mutate(
            { scope, key: a.key },
            { onSuccess: () => toast.success('Asked the workstation to swap them') },
          );
        }}
      />
      <ErrorBox error={removeKey.error ?? removeLogin.error ?? promoteM.error} />
    </li>
  );
}

function AiTile({
  tile,
  ctx,
  online,
  focus,
  openConnect,
}: {
  tile: AiRuntimeTile;
  ctx: PageCtx;
  online: boolean;
  focus: { kind: string; instance: string } | null;
  openConnect: boolean;
}) {
  const scope = tile.id as AccountScope;
  const kind = tile.integrationKind ? integrationKind(tile.integrationKind) : undefined;
  const [addOpen, setAddOpen] = useState(false);
  const notInstalled = tile.installed === false;
  const blocked = !online
    ? `${ctx.workstationName} is offline.`
    : tile.runnerTooOld
      ? 'Update the runner on this workstation to 0.1.58 or later to use accounts.'
      : notInstalled
        ? `${tile.label} is not installed on this workstation.`
        : null;
  const isFocusTile = focus?.kind === tile.id;
  const login = tile.kind === 'login';
  const def = accountScopeDef(tile.id);
  return (
    <article
      data-testid={`ai-tile-${tile.id}`}
      id={`tile-${tile.id}`}
      className="rounded-card border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-fg">{tile.label}</h3>
        {tile.installed === true && (
          <Badge tone="green" data-testid={`ai-installed-${tile.id}`}>
            Installed{tile.version ? ` ${tile.version}` : ''}
          </Badge>
        )}
        {notInstalled && (
          <Badge tone="neutral" data-testid={`ai-not-installed-${tile.id}`}>
            Not installed
          </Badge>
        )}
        {tile.runnerTooOld && (
          <Badge tone="amber" data-testid={`ai-old-runner-${tile.id}`}>
            Runner too old
          </Badge>
        )}
        {tile.keyInEffect && tile.keyInEffect !== 'none' && (
          <span className="text-xs text-subtle" data-testid={`ai-key-in-effect-${tile.id}`}>
            {tile.keyInEffect === 'org'
              ? 'The organization’s key is in effect'
              : 'This workstation’s own key is in effect'}
          </span>
        )}
      </div>
      {notInstalled && (
        <p className="mt-2 text-sm text-muted" data-testid={`ai-install-${tile.id}`}>
          Install it on {ctx.workstationName}: <code className="font-mono text-xs">{tile.installHint}</code>
          {tile.note ? ` ${tile.note}` : ''}
        </p>
      )}
      {tile.runnerTooOld && (
        <p className="mt-2 text-sm text-muted">
          This runner does not keep accounts for {tile.label} yet. Update it to 0.1.58 or later.
        </p>
      )}
      {tile.kind === 'runtime' && tile.installed === true && tile.note && (
        <p className="mt-2 text-sm text-muted">{tile.note}</p>
      )}
      {tile.accounts.length > 0 && (
        <ul className="mt-3 flex flex-col gap-2" aria-label={`${tile.label} accounts`}>
          {tile.accounts.map((a) => (
            <AccountRow
              key={a.key}
              tile={tile}
              a={a}
              ctx={ctx}
              blocked={blocked}
              focused={isFocusTile && (focus?.instance === a.key || (!focus?.instance && a.main))}
              openOnArrival={openConnect}
            />
          ))}
        </ul>
      )}
      {(login || tile.kind === 'key') && !tile.runnerTooOld && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={!!blocked}
            title={blocked ?? undefined}
            data-testid={`ai-add-${tile.id}`}
            onClick={() => setAddOpen(true)}
          >
            Add a named account
          </Button>
          {blocked && <span className="text-xs text-muted">{blocked}</span>}
        </div>
      )}
      {login && kind && (
        <ConnectDialog open={addOpen} onOpenChange={setAddOpen} ctx={ctx} kind={kind} instance={null} />
      )}
      {!login && tile.kind === 'key' && isKeyScope(scope) && (
        <ProviderKeyDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          workstationId={ctx.workstationId}
          workstationName={ctx.workstationName}
          provider={scope}
          label={tile.label}
          account={null}
          existing={false}
        />
      )}
      {def?.kind === 'key' && (
        <p className="mt-2 text-xs text-subtle">
          Calls go from this workstation straight to the provider. A named account is this workstation’s own
          key and is not capped.
        </p>
      )}
    </article>
  );
}

/**
 * Integrations > AI runtime (S-A): one tile per runtime and provider, each listing its accounts (the main one and the named
 * ones) with their state and the actions that make sense: sign in (the CLI's own login, run on the workstation), set or
 * replace a key (sealed in this browser), add a named account, remove, make main. Organization keys and their monthly caps
 * stay under Settings, Model providers.
 */
export function AiRuntimeSection({
  ctx,
  focus,
  openConnect,
}: {
  ctx: PageCtx;
  focus: { kind: string; instance: string } | null;
  openConnect: boolean;
}) {
  const q = useAiRuntimes(ctx.workstationId);
  if (q.isPending)
    return (
      <p className="text-sm text-muted" data-testid="ai-loading">
        Reading the AI runtimes of {ctx.workstationName}...
      </p>
    );
  if (q.error || !q.data)
    return (
      <Callout tone="warning" data-testid="ai-error">
        Could not read the AI runtimes of {ctx.workstationName}.
      </Callout>
    );
  const { tiles = [], online, lastPromote } = q.data;
  // Claude Code has its own tiles above; opencode and the providers follow the login runtimes
  const rest = tiles.filter((t) => t.id !== 'claude-code');
  const keys = rest.filter((t) => t.kind === 'key');
  const runtimes = rest.filter((t) => t.kind !== 'key');
  return (
    <div className="flex flex-col gap-3" data-testid="ai-section">
      {lastPromote && !lastPromote.ok && (
        <Callout tone="warning" role="alert" data-testid="ai-promote-error">
          Could not make {lastPromote.key} the main account: {lastPromote.error ?? 'the workstation refused'}.
        </Callout>
      )}
      <p className="text-sm text-muted">
        Each runtime and provider has a <strong>main account</strong> and any number of{' '}
        <strong>named accounts</strong>. A project picks an account per provider in its settings and falls
        back to the main account when you allow it; the CEO, DevOps and chats always use the main account.{' '}
        <Link to="/settings/providers" className="text-brand-text underline" data-testid="ai-models-link">
          Organization keys and monthly caps: Settings, Model providers
        </Link>
        .
      </p>
      {runtimes.map((t) => (
        <AiTile key={t.id} tile={t} ctx={ctx} online={online} focus={focus} openConnect={openConnect} />
      ))}
      <h3 className="mt-2 text-sm font-semibold text-fg" id="h-ai-keys">
        API keys and cloud accounts
      </h3>
      {keys.map((t) => (
        <AiTile key={t.id} tile={t} ctx={ctx} online={online} focus={focus} openConnect={openConnect} />
      ))}
    </div>
  );
}
