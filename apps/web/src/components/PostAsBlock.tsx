import {
  APP_PROVIDER_LABEL,
  COMMIT_IDENTITY_SOURCE_LABEL,
  type CommitAsResponse,
  oneAppPerProviderMessage,
  type PostAsAppOption,
  type PostAsRepoRow,
} from '@aom/shared';
import { useEffect, useState } from 'react';
import { useRecheckPostAs, useSavePostAs } from '../api/queries/commit-as.ts';
import { Button, ErrorBox, useToast } from './ui.tsx';

const FORGE_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
  azure: 'Azure DevOps',
  git: 'git',
};
const forgeName = (f: string) => FORGE_LABEL[f] ?? f;

/**
 * Which identity and credential one repository uses, in the owner's words: the app's bot, the project's Commit as, or
 * the repository/workstation git config. Comes from the server's resolver, so it says what the shift will do.
 */
export function effectiveRepoText(
  row: PostAsRepoRow,
  commitAs: CommitAsResponse['commitAs'],
  selected: readonly PostAsAppOption[],
): { text: string; warning?: string } {
  const r = row.resolved;
  const credential = ` Pushed with the workstation's ${forgeName(row.forge)} login.`;
  if (r.source === 'app' && r.app) {
    const state = selected.find((s) => s.integrationId === r.app?.integrationId)?.state;
    // The bot is the commit author and committer. Pushes, pull requests and comments still use the workstation's forge
    // login until shifts push with the app's installation token; the text says what happens today.
    const text = `Commits are made as ${r.app.botName} <${r.app.botEmail}> (${APP_PROVIDER_LABEL[r.app.provider]} ${r.app.label}).${credential} Pull requests and comments also use that login for now.`;
    if (state === 'not_connected' || state === 'error')
      return {
        text,
        warning:
          'The app is not working; shifts for this repository will stop rather than use another identity.',
      };
    if (!row.access || row.access.state === 'error')
      return {
        text,
        warning: 'Access not checked yet; shifts stop if the app cannot reach this repository.',
      };
    return { text };
  }
  const base =
    r.source === 'project' && commitAs
      ? `Commits are made as ${commitAs.name} <${commitAs.email}> (from ${COMMIT_IDENTITY_SOURCE_LABEL.project}).`
      : `Commits are made with ${COMMIT_IDENTITY_SOURCE_LABEL.repo}, else ${COMMIT_IDENTITY_SOURCE_LABEL.global}.`;
  const appLabel = selected.find((s) => APP_PROVIDER_LABEL[s.provider])?.label ?? 'The app';
  const warning =
    r.fallbackReason === 'not_covered'
      ? `${appLabel} cannot reach this repository; it uses the fallback above.`
      : r.fallbackReason === 'app_removed'
        ? 'App removed, using fallback.'
        : r.fallbackReason === 'no_app_for_forge'
          ? `No app for ${forgeName(row.forge)}; uses the fallback.`
          : undefined;
  return { text: base + credential, ...(warning ? { warning } : {}) };
}

/** The local check for two apps of one provider; the server sends the same message and stays authoritative. */
export function providerClash(ids: readonly string[], options: readonly PostAsAppOption[]): string | null {
  const picked = ids
    .map((id) => options.find((o) => o.integrationId === id))
    .filter((o): o is PostAsAppOption => !!o);
  for (let i = 1; i < picked.length; i++) {
    const cur = picked[i] as PostAsAppOption;
    const first = picked.slice(0, i).find((p) => p.provider === cur.provider);
    if (first) return oneAppPerProviderMessage(cur.provider, first.label);
  }
  return null;
}

/** Project settings > Commit as > Post as app: tick the organization app the project's shifts act as. */
export function PostAsBlock({ projectId, data }: { projectId: string; data: CommitAsResponse }) {
  const postAs = data.postAs;
  const save = useSavePostAs(projectId);
  const recheck = useRecheckPostAs(projectId);
  const toast = useToast();
  const [ticked, setTicked] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => setTicked((postAs?.selected ?? []).map((s) => s.integrationId)), [postAs]);
  if (!postAs) return null;

  const removed = postAs.selected.filter((s) => s.state === 'removed');
  const options = [...postAs.available, ...removed];
  const toggle = (id: string, on: boolean) => {
    const next = on ? [...ticked, id] : ticked.filter((x) => x !== id);
    setTicked(next);
    setProblem(providerClash(next, options));
  };
  const submit = () => {
    const clash = providerClash(ticked, options);
    if (clash) return setProblem(clash);
    save.mutate(
      { apps: ticked.map((integrationId) => ({ integrationId })) },
      { onSuccess: () => toast.success('Post as saved') },
    );
  };

  return (
    <section className="mb-4 flex flex-col gap-2" aria-label="Post as app" data-testid="post-as">
      <h3 className="text-sm font-semibold text-fg">Post as app</h3>
      <p className="text-sm text-muted">
        Shifts commit, push and post as the ticked app's bot on repositories its installation reaches. Without
        an app, the Commit as setting below is used.
      </p>
      <p className="text-xs text-subtle" data-testid="post-as-trackers">
        Comments on GitHub issues are posted as the selected GitHub App too. Jira comments still use this
        workstation's Jira connection: a GitHub App cannot post to Jira.
      </p>
      {options.length === 0 && (
        <p className="text-sm text-subtle">
          No apps are registered on the Apps tab of Organization settings.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {options.map((o) => {
          const disabled =
            !postAs.canSelect || (o.state !== 'connected' && !ticked.includes(o.integrationId));
          return (
            <li key={o.integrationId} className="flex flex-col">
              <label className="flex min-h-11 cursor-pointer items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  className="h-5 w-5"
                  checked={ticked.includes(o.integrationId)}
                  disabled={disabled}
                  onChange={(e) => toggle(o.integrationId, e.target.checked)}
                />
                <span>
                  {o.label} ({APP_PROVIDER_LABEL[o.provider]}
                  {o.botName ? `, ${o.botName}` : ''})
                </span>
                <span className="text-xs text-subtle" data-testid={`post-as-state-${o.integrationId}`}>
                  {o.state === 'connected'
                    ? 'connected'
                    : o.state === 'removed'
                      ? 'removed'
                      : o.state === 'error'
                        ? 'error'
                        : 'not connected'}
                </span>
              </label>
              {o.state === 'removed' && (
                <p className="text-xs text-danger-fg">App removed, using fallback.</p>
              )}
              {o.state !== 'connected' && o.state !== 'removed' && (
                <p className="text-xs text-subtle">
                  Connect it on the Apps tab of Organization settings first.
                </p>
              )}
            </li>
          );
        })}
      </ul>
      {problem && (
        <p role="alert" className="text-sm text-danger-fg">
          {problem}
        </p>
      )}
      {save.isError && <ErrorBox error={save.error} />}
      {postAs.canSelect ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={submit} disabled={save.isPending || !!problem}>
            Save apps
          </Button>
          {postAs.selected.length > 0 && (
            <Button type="button" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
              Check access again
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-subtle">Only an organization Owner or Admin can choose the app.</p>
      )}
      {postAs.lastChange && (
        <p className="text-xs text-subtle">
          Last changed by {postAs.lastChange.by} on {new Date(postAs.lastChange.at).toLocaleString()}.
        </p>
      )}
      {(data.repos ?? []).length > 0 && (
        <ul className="flex flex-col gap-1 text-sm" data-testid="post-as-repos">
          {(data.repos ?? []).map((row) => {
            const t = effectiveRepoText(row, data.commitAs, postAs.selected);
            return (
              <li key={row.repoId} className="break-words">
                <span className="font-medium text-fg">{row.repoName}:</span>{' '}
                <span className="text-muted">{t.text}</span>
                {t.warning && <span className="block text-xs text-danger-fg">{t.warning}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
