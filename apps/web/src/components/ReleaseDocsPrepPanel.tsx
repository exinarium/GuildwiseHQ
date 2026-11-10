import { useEffect, useState } from 'react';
import {
  useReleaseDocsPrepSettings,
  useSaveReleaseDocsPrepSettings,
} from '../api/queries/releaseDocsPrep.ts';
import { ErrorBox, Panel } from './ui.tsx';

/**
 * Project settings > Release prep (docs and videos): an on/off switch (off by default) and a checklist of the registered
 * prep steps. Only the project Owner or an organization Owner or Admin changes it; everyone else reads it.
 */
export function ReleaseDocsPrepPanel({ projectId }: { projectId: string }) {
  const q = useReleaseDocsPrepSettings(projectId);
  const save = useSaveReleaseDocsPrepSettings(projectId);
  const [enabled, setEnabled] = useState(false);
  const [autoStart, setAutoStart] = useState(false);
  const [steps, setSteps] = useState<Record<string, boolean>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // The repository whose path save failed: its error is shown under its field, not in the box below.
  const [failedRepo, setFailedRepo] = useState<string | null>(null);
  // Responses are only schema-checked in dev builds: a body without the expected fields reads as off, read-only and
  // with no steps rather than breaking the settings page around it.
  const data = q.data;
  const listed = Array.isArray(data?.steps) ? data.steps : [];
  const repos = Array.isArray(data?.repos) ? data.repos : [];
  const canEdit = data?.canEdit === true;
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled === true);
    setAutoStart(data.autoStart === true);
    setSteps(Object.fromEntries((Array.isArray(data.steps) ? data.steps : []).map((s) => [s.id, s.enabled])));
    setDrafts(
      Object.fromEntries((Array.isArray(data.repos) ? data.repos : []).map((r) => [r.id, r.guidePath ?? ''])),
    );
  }, [data]);

  const title = 'Release prep (docs and videos)';
  if (q.isPending) return <Panel title={title}>Loading...</Panel>;
  if (q.isError)
    return (
      <Panel title={title}>
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </Panel>
    );
  const change = (next: { enabled: boolean; steps: Record<string, boolean>; autoStart?: boolean }) => {
    setEnabled(next.enabled);
    setSteps(next.steps);
    if (next.autoStart !== undefined) setAutoStart(next.autoStart);
    setFailedRepo(null);
    // autoStart is sent only when it changes; the server keeps the saved value otherwise.
    save.mutate(next);
  };
  const saveGuidePath = (id: string, saved: string | null) => {
    const draft = (drafts[id] ?? '').trim();
    if (draft === (saved ?? '')) return;
    setFailedRepo(id);
    save.mutate({ enabled, steps, guidePaths: { [id]: draft } });
  };
  const row = 'flex min-h-11 items-start gap-3 py-2';

  return (
    <Panel title={title} data-testid="release-docs-prep-settings">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          Before a release ships, an agent can analyse the changes in every repository of this project and
          commit the results to the release branch. When this is on, the release cannot be shipped until the
          prep has passed or you skip it for that release. Off by default.
        </p>
        {!canEdit && (
          <p className="text-sm text-subtle" data-testid="release-docs-prep-readonly">
            Only the project Owner or an organization Owner or Admin changes this.
          </p>
        )}
        <label className={row}>
          <input
            type="checkbox"
            role="switch"
            aria-checked={enabled}
            className="mt-0.5 size-5"
            checked={enabled}
            disabled={!canEdit || save.isPending}
            onChange={(e) => change({ enabled: e.target.checked, steps })}
          />
          <span className="text-sm font-medium text-fg">Run release prep before a release ships</span>
        </label>
        {Array.isArray(data?.steps) && (
          <label className={row}>
            <input
              type="checkbox"
              aria-describedby="prep-auto-start-help"
              data-testid="release-docs-prep-auto-start"
              className="mt-0.5 size-5"
              checked={autoStart}
              disabled={!canEdit || !enabled || save.isPending}
              onChange={(e) => change({ enabled, steps, autoStart: e.target.checked })}
            />
            <span className="flex flex-col">
              <span className="text-sm font-medium text-fg">
                Start automatically when the release is ready on the test site
              </span>
              <span id="prep-auto-start-help" className="text-xs text-subtle">
                Release prep starts by itself once the release-branch head of every repository is live and
                healthy on its test site and meets the live site's release requirements (release hours and
                freeze do not count). If a run already exists for this release, nothing starts; use Run or
                Retry.
              </span>
            </span>
          </label>
        )}
        <fieldset className="flex flex-col" disabled={!canEdit || save.isPending}>
          <legend className="text-sm font-medium text-fg">Steps</legend>
          {listed.map((s) => (
            <label key={s.id} className={row}>
              <input
                type="checkbox"
                className="mt-0.5 size-5"
                checked={steps[s.id] ?? s.enabled}
                onChange={(e) => change({ enabled, steps: { ...steps, [s.id]: e.target.checked } })}
              />
              <span className="flex flex-col">
                <span className="text-sm text-fg">{s.label}</span>
                <span className="text-xs text-subtle">{s.description}</span>
                {(steps[s.id] ?? s.enabled) &&
                  (s.requires ?? [])
                    .filter((r) => !(steps[r] ?? listed.find((x) => x.id === r)?.enabled ?? false))
                    .map((r) => (
                      <span key={r} className="text-xs text-warning-soft-fg" data-testid={`prep-needs-${r}`}>
                        Needs {listed.find((x) => x.id === r)?.label ?? r}
                      </span>
                    ))}
              </span>
            </label>
          ))}
        </fieldset>
        {repos.length > 0 && (
          <div
            role="group"
            aria-labelledby="prep-guide-heading"
            className="flex flex-col gap-3"
            data-testid="prep-guide-paths"
          >
            <span id="prep-guide-heading" className="text-sm font-medium text-fg">
              User guide
            </span>
            {repos.map((r) => {
              const err = failedRepo === r.id && save.error instanceof Error ? save.error.message : null;
              return (
                <div key={r.id} className="flex flex-col gap-1">
                  <label htmlFor={`prep-guide-path-${r.id}`} className="text-sm text-fg">
                    {r.name}
                  </label>
                  <input
                    id={`prep-guide-path-${r.id}`}
                    data-testid={`prep-guide-path-${r.id}`}
                    type="text"
                    disabled={!canEdit || save.isPending}
                    className="min-h-11 w-full rounded-md border border-border bg-surface px-3 text-sm text-fg"
                    placeholder={data?.defaultGuidePath ?? 'docs/USER-GUIDE.md'}
                    value={drafts[r.id] ?? ''}
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    inputMode="text"
                    enterKeyHint="done"
                    aria-invalid={err ? true : undefined}
                    aria-describedby={`prep-guide-help-${r.id}${err ? ` prep-guide-error-${r.id}` : ''}`}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.id]: e.target.value }))}
                    onBlur={() => saveGuidePath(r.id, r.guidePath)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveGuidePath(r.id, r.guidePath);
                      }
                    }}
                  />
                  <span id={`prep-guide-help-${r.id}`} className="text-xs text-subtle">
                    Relative to the repository, ending in .md. Empty: {data?.defaultGuidePath}. The PDF guide
                    is rebuilt only for a file named USER-GUIDE.md.
                  </span>
                  {err && (
                    <span
                      id={`prep-guide-error-${r.id}`}
                      role="alert"
                      className="text-xs text-danger-soft-fg"
                      data-testid={`prep-guide-error-${r.id}`}
                    >
                      {err}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {failedRepo === null && <ErrorBox error={save.error} />}
      </div>
    </Panel>
  );
}
