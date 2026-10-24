import {
  ACCOUNT_SCOPES,
  type AccountScope,
  type AccountScopeDef,
  ORG_ACCOUNT,
  type ProjectDetailResponse,
  type ProjectProviderAccountsView,
  ProviderAccountKeySchema,
} from '@aom/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useProviderAccounts, useSetProviderAccount } from '../api/queries/ai-runtimes.ts';
import { focusOf, integrationsLink } from '../lib/integrations.ts';
import { formatUntil } from './UsageLimitBanner.tsx';
import { Badge, Button, ErrorBox, Panel, Select, TextInput } from './ui.tsx';

const MAIN = '';
const NEW = '__new__';

type Station = ProjectProviderAccountsView['workstations'][number];

/** The account choice shown as words: main, a name, or the organization's key. */
export const choiceLabel = (key: string | null | undefined): string =>
  !key ? 'Main account' : key === ORG_ACCOUNT ? 'Organization key' : key;

/** One workstation's line for the project's account on one provider: ready, limited, sign-in or key needed, runner too old. */
export function stationStatus(
  w: Station,
  view: Pick<ProjectProviderAccountsView, 'kind' | 'setting' | 'label'>,
): { tone: 'ok' | 'warn' | 'bad'; text: string; fix?: 'sign-in' | 'key' } {
  const key = view.setting.key;
  if (!w.supportsAccounts)
    return { tone: 'bad', text: 'Runner too old: update it to 0.1.58 or later to use this account.' };
  const a = w.account ?? (key ? undefined : w.main);
  const login = view.kind === 'login';
  if (!a)
    return login
      ? { tone: 'bad', text: `Account ${key} is not set up here yet: sign in to set it up.`, fix: 'sign-in' }
      : {
          tone: 'bad',
          text: `No key for ${key === ORG_ACCOUNT ? 'the organization’s key' : `account ${key}`} here.`,
          fix: 'key',
        };
  if (a.login !== 'ok')
    return login
      ? {
          tone: 'bad',
          text:
            a.login === 'expired'
              ? 'Sign-in needed: the login has expired.'
              : 'Sign-in needed: not signed in yet.',
          fix: 'sign-in',
        }
      : { tone: 'bad', text: a.detail ?? 'No key here.', fix: 'key' };
  if (a.usage === 'limited')
    return { tone: 'warn', text: `Limited until ${a.limitedUntil ? formatUntil(a.limitedUntil) : 'later'}.` };
  const who = [a.email, a.source === 'org' ? 'organization key' : undefined].filter(Boolean).join(', ');
  return { tone: 'ok', text: `Ready${who ? ` (${who})` : ''}.` };
}

function ScopeRow({
  projectId,
  def,
  current,
  canChange,
}: {
  projectId: string;
  def: AccountScopeDef;
  current: { key: string | null; fallbackToMain: boolean };
  canChange: boolean;
}) {
  const scope = def.id as AccountScope;
  const [open, setOpen] = useState(false);
  const view = useProviderAccounts(projectId, scope, { enabled: open });
  const set = useSetProviderAccount(projectId, scope);
  const [choice, setChoice] = useState<string>(current.key ?? MAIN);
  const [newKey, setNewKey] = useState('');
  const [fallback, setFallback] = useState(current.fallbackToMain);
  useEffect(() => {
    setChoice(current.key ?? MAIN);
    setFallback(current.fallbackToMain);
  }, [current.key, current.fallbackToMain]);

  const keyText = choice === NEW ? newKey.trim() : choice;
  const keyError =
    choice === NEW && newKey.trim() !== '' && !ProviderAccountKeySchema.safeParse(newKey.trim()).success
      ? 'Use lowercase letters, digits and dashes, starting with a letter (up to 32), and not "main" or "org"'
      : undefined;
  const chosen: string | null = keyText === '' ? null : keyText;
  const valid = !keyError && (choice !== NEW || newKey.trim() !== '');
  const dirty = valid && (chosen !== current.key || (chosen !== null && fallback !== current.fallbackToMain));
  const known = view.data?.knownKeys ?? [];
  const options = [...new Set([...known, ...(current.key ? [current.key] : [])])].sort();
  const id = def.id;
  return (
    <li className="rounded-control border border-line bg-canvas p-3 text-sm" data-testid={`pa-row-${id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">{def.label}</span>
        <Badge tone={current.key ? 'brand' : 'neutral'}>
          <span data-testid={`pa-state-${id}`}>{choiceLabel(current.key)}</span>
        </Badge>
        {current.key && current.fallbackToMain && (
          <span className="text-xs text-subtle">falls back to main</span>
        )}
        <Button size="sm" variant="ghost" data-testid={`pa-toggle-${id}`} onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : canChange ? 'Change' : 'Show'}
        </Button>
      </div>
      {open && (
        <div className="mt-2">
          <form
            aria-label={`${def.label} account`}
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (dirty)
                set.mutate({ accountKey: chosen, fallbackToMain: chosen === null ? false : fallback });
            }}
          >
            <div className="max-w-sm">
              <Select
                label="Account"
                value={choice}
                disabled={!canChange || set.isPending}
                data-testid={`pa-select-${id}`}
                onChange={(e) => setChoice(e.target.value)}
              >
                <option value={MAIN}>Main account (each workstation’s own)</option>
                {options.map((k) => (
                  <option key={k} value={k}>
                    {k === ORG_ACCOUNT ? 'Organization key (counts against its monthly cap)' : k}
                  </option>
                ))}
                {def.kind === 'key' && view.data?.orgKey && !options.includes(ORG_ACCOUNT) && (
                  <option value={ORG_ACCOUNT}>Organization key (counts against its monthly cap)</option>
                )}
                <option value={NEW}>New name…</option>
              </Select>
            </div>
            {choice === NEW && (
              <div className="max-w-sm">
                <TextInput
                  label="New account name"
                  placeholder="work"
                  value={newKey}
                  disabled={!canChange}
                  onChange={(e) => setNewKey(e.target.value)}
                  error={keyError}
                  hint="The name you gave the account on the Integrations page, the same on every workstation."
                  data-testid={`pa-new-${id}`}
                />
              </div>
            )}
            <label className="flex items-start gap-2 text-fg">
              <input
                type="checkbox"
                className="mt-1"
                checked={fallback}
                disabled={!canChange || chosen === null || set.isPending}
                data-testid={`pa-fallback-${id}`}
                onChange={(e) => setFallback(e.target.checked)}
              />
              <span>
                If this account is out (usage limit, login or key), use the workstation’s main account.
                Otherwise this project’s tickets pause.
              </span>
            </label>
            <div>
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={!canChange || !dirty || set.isPending}
                loading={set.isPending}
                data-testid={`pa-save-${id}`}
              >
                Save account
              </Button>
            </div>
          </form>
          <ErrorBox error={set.error} />
          {view.data && (
            <div className="mt-3 border-t border-line pt-2" data-testid={`pa-stations-${id}`}>
              {view.data.workstations.length === 0 && (
                <p className="text-muted">No workstation has an agent for this project on {def.label} yet.</p>
              )}
              <ul className="flex flex-col gap-1">
                {view.data.workstations.map((w) => {
                  const st = stationStatus(w, view.data);
                  return (
                    <li key={w.workstationId} data-testid={`pa-station-${id}-${w.workstationId}`}>
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
                        data-testid={`pa-status-${id}`}
                      >
                        {st.text}
                      </span>
                      {st.fix && (
                        <>
                          {' '}
                          <Link
                            className="text-brand-text underline"
                            data-testid={`pa-fix-${id}`}
                            to={integrationsLink(w.workstationId, focusOf(id, view.data.setting.key ?? ''), {
                              connect: true,
                            })}
                          >
                            {st.fix === 'sign-in' ? 'Sign in' : 'Add the key'}
                          </Link>
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * "Accounts for other providers" (S-A): which account the project's tickets use for Codex, the Gemini CLI and each provider key.
 * Claude Code's account has its own panel. Every card, question and specification task about one of the project's tickets uses
 * the account for the provider its agent's model spends; the CEO, DevOps and chats always use the main account. When an account is
 * out (usage limit, login, key) the tickets pause, unless the project may use the main account meanwhile (off by default). The
 * organization's key is one more account to pick: its monthly cap still applies.
 */
export function ProviderAccountPanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const scopes = ACCOUNT_SCOPES.filter((s) => s.id !== 'claude-code');
  return (
    <Panel>
      <h2 className="mb-2 text-lg font-semibold text-fg">Accounts for other providers</h2>
      <p className="mb-3 text-sm text-muted">
        Choose the account this project’s tickets use for Codex, the Gemini CLI and each API provider; the
        default is each workstation’s main account. Accounts are made on the Integrations page, AI runtime.
        The CEO, DevOps and chats always use the main account.
      </p>
      <ul className="flex flex-col gap-2" data-testid="provider-accounts">
        {scopes.map((def) => (
          <ScopeRow
            key={def.id}
            projectId={projectId}
            def={def}
            current={project.providerAccounts?.[def.id] ?? { key: null, fallbackToMain: false }}
            canChange={canChange}
          />
        ))}
      </ul>
      {!canChange && (
        <p className="mt-2 text-sm text-subtle">
          Only the project Owner and the organization’s Owners and Admins can change these settings.
        </p>
      )}
    </Panel>
  );
}
