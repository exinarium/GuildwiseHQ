import {
  type ClaudeAccountInfo,
  ClaudeAccountKeySchema,
  INTEGRATION_KINDS,
  type ProjectClaudeAccountsView,
  type ProjectDetailResponse,
} from '@aom/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useClaudeAccount, useSetClaudeAccount } from '../api/queries/projects.ts';
import { focusOf, integrationsLink } from '../lib/integrations.ts';
import { formatUntil } from './UsageLimitBanner.tsx';
import { Badge, Button, ErrorBox, Panel, Select, TextInput } from './ui.tsx';

const MAIN = '';
const NEW = '__new__';

type Station = ProjectClaudeAccountsView['workstations'][number];

const minRunner = INTEGRATION_KINDS.find((k) => k.id === 'claude-code')?.minRunnerForInstance ?? '0.1.33';

/** One workstation's line for the project's account: ready, limited, sign-in needed, provisioning or runner too old. */
export function stationStatus(
  w: Station,
  key: string,
): { tone: 'ok' | 'warn' | 'bad'; text: string; signIn?: boolean } {
  if (!w.supportsAccounts)
    return { tone: 'bad', text: `Runner too old: update it to ${minRunner} or later to use this account.` };
  const a = w.account;
  if (a) {
    if (a.login !== 'ok')
      return {
        tone: 'bad',
        text:
          a.login === 'expired'
            ? 'Sign-in needed: the login has expired.'
            : 'Sign-in needed: the account has not been signed in yet.',
        signIn: true,
      };
    if (a.usage === 'limited')
      return {
        tone: 'warn',
        text: `Limited until ${a.limitedUntil ? formatUntil(a.limitedUntil) : 'later'}${a.limitedLabel ? ` (${a.limitedLabel})` : ''}.`,
      };
    return { tone: 'ok', text: `Ready${describe(a)}.` };
  }
  switch (w.provisioning) {
    case 'needs_owner':
      return {
        tone: 'bad',
        text: `Needs setup on the machine: run "aom-runner accounts add ${key}" and then "aom-runner accounts login ${key}".`,
      };
    case 'failed':
      return {
        tone: 'bad',
        text: `Could not be set up. Run "aom-runner accounts add ${key}" on the machine.`,
      };
    case 'awaiting_login':
      return {
        tone: 'bad',
        text: 'Sign-in needed: the account was created and waits for its login.',
        signIn: true,
      };
    default:
      return { tone: 'warn', text: 'Provisioning: the workstation is setting this account up.' };
  }
}

const describe = (a: ClaudeAccountInfo): string =>
  a.email || a.plan ? ` (${[a.email, a.plan].filter(Boolean).join(', ')})` : '';

/** Same key signed in as different people on different workstations. */
export function emailMismatch(view: ProjectClaudeAccountsView): string | null {
  const emails = (view.workstations ?? [])
    .filter((w) => w.account?.email)
    .map((w) => ({ name: w.name, email: w.account?.email as string }));
  const distinct = new Set(emails.map((e) => e.email));
  if (distinct.size < 2) return null;
  return emails.map((e) => `${e.email} on ${e.name}`).join(' but ');
}

/**
 * "Claude account": which Claude subscription the project's tickets run on (docs/design/claude-accounts.md). A key such
 * as `work`; the workstation's runner sets the account up. Every card, question and BA task about one of the project's
 * tickets uses it; CEO, DevOps and chats always use each workstation's main account. When the account is out (usage limit
 * or login) tickets pause, unless the project may use the main account meanwhile (off by default).
 */
export function ClaudeAccountPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const view = useClaudeAccount(projectId);
  const set = useSetClaudeAccount(projectId);
  const current = project.claudeAccount ?? { key: null, fallbackToMain: false };
  const [choice, setChoice] = useState<string>(current.key ?? MAIN);
  const [newKey, setNewKey] = useState('');
  const [fallback, setFallback] = useState(current.fallbackToMain);
  useEffect(() => {
    setChoice(current.key ?? MAIN);
    setFallback(current.fallbackToMain);
  }, [current.key, current.fallbackToMain]);

  const keyText = choice === NEW ? newKey.trim() : choice;
  const keyError =
    choice === NEW && newKey.trim() !== '' && !ClaudeAccountKeySchema.safeParse(newKey.trim()).success
      ? 'Use lowercase letters, digits and dashes, starting with a letter (up to 32), and not "main"'
      : undefined;
  const chosen: string | null = keyText === '' ? null : keyText;
  const valid = !keyError && (choice !== NEW || newKey.trim() !== '');
  const dirty = valid && (chosen !== current.key || (chosen !== null && fallback !== current.fallbackToMain));
  const known = view.data?.knownKeys ?? [];
  const options = [...new Set([...known, ...(current.key ? [current.key] : [])])].sort();
  const mismatch = view.data ? emailMismatch(view.data) : null;

  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">
        Claude account
        <Badge tone={current.key ? 'brand' : 'neutral'}>
          <span data-testid="claude-account-state">{current.key ?? 'Main account'}</span>
        </Badge>
      </h2>
      <p className="text-sm text-muted">
        Choose the Claude subscription this project's tickets run on. Every card, question and specification
        task about one of its tickets uses it; the CEO, the DevOps engineer and chats always use each
        workstation's main account. Each workstation's runner sets a new account up by itself; you only sign
        in once.
      </p>
      <form
        aria-label="Claude account"
        className="mt-3 flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) set.mutate({ accountKey: chosen, fallbackToMain: chosen === null ? false : fallback });
        }}
      >
        <div className="max-w-sm">
          <Select
            label="Account"
            value={choice}
            disabled={!canChange || set.isPending}
            data-testid="claude-account-select"
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value={MAIN}>Main account (each workstation's own)</option>
            {options.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
            <option value={NEW}>New key…</option>
          </Select>
        </div>
        {choice === NEW && (
          <div className="max-w-sm">
            <TextInput
              label="New account key"
              placeholder="work"
              value={newKey}
              disabled={!canChange}
              onChange={(e) => setNewKey(e.target.value)}
              error={keyError}
              hint="A short name, the same on every workstation. Tickets of this project will use that account."
              data-testid="claude-account-new"
            />
          </div>
        )}
        <label className="flex items-start gap-2 text-sm text-fg">
          <input
            type="checkbox"
            className="mt-1"
            checked={fallback}
            disabled={!canChange || chosen === null || set.isPending}
            data-testid="claude-account-fallback"
            onChange={(e) => setFallback(e.target.checked)}
          />
          <span>
            If this account is out (usage limit or login), use the workstation's main account. Otherwise this
            project's tickets pause.
          </span>
        </label>
        <div>
          <Button
            type="submit"
            variant="primary"
            disabled={!canChange || !dirty || set.isPending}
            loading={set.isPending}
            data-testid="claude-account-save"
          >
            Save account
          </Button>
        </div>
      </form>
      {!canChange && (
        <p className="mt-2 text-sm text-subtle" data-testid="claude-account-readonly">
          Only the project Owner and the organization's Owners and Admins can change this setting.
        </p>
      )}
      <ErrorBox error={set.error} />
      {current.key && view.data && (
        <div className="mt-4 border-t border-line pt-3" data-testid="claude-account-stations">
          <h3 className="mb-2 text-sm font-medium text-fg">Workstations</h3>
          {(view.data.workstations ?? []).length === 0 && (
            <p className="text-sm text-muted">No workstation has an agent for this project yet.</p>
          )}
          <ul className="flex flex-col gap-1.5">
            {(view.data.workstations ?? []).map((w) => {
              const st = stationStatus(w, current.key as string);
              return (
                <li
                  key={w.workstationId}
                  className="text-sm text-fg"
                  data-testid={`claude-account-station-${w.workstationId}`}
                >
                  <span className="font-medium">{w.name}</span>
                  {!w.connected && <span className="text-subtle"> (offline)</span>}
                  {': '}
                  <span
                    className={
                      st.tone === 'ok'
                        ? 'text-success-text'
                        : st.tone === 'warn'
                          ? 'text-warning-text'
                          : 'text-danger'
                    }
                    data-testid="claude-account-status"
                  >
                    {st.text}
                  </span>
                  {st.signIn && (
                    <>
                      {' '}
                      <Link
                        className="text-brand-text underline"
                        data-testid="claude-account-signin"
                        to={integrationsLink(w.workstationId, focusOf('claude-code', current.key as string), {
                          connect: true,
                        })}
                      >
                        Sign in
                      </Link>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {mismatch && (
            <p className="mt-2 text-sm text-warning-text" data-testid="claude-account-mismatch">
              The key {current.key} is signed in as different people: {mismatch}. That is allowed, but check
              it is what you want.
            </p>
          )}
        </div>
      )}
    </Panel>
  );
}
