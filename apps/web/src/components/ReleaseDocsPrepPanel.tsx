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
  const [steps, setSteps] = useState<Record<string, boolean>>({});
  const data = q.data;
  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setSteps(Object.fromEntries(data.steps.map((s) => [s.id, s.enabled])));
  }, [data]);

  const title = 'Release prep (docs and videos)';
  if (q.isPending) return <Panel title={title}>Loading...</Panel>;
  if (q.isError)
    return (
      <Panel title={title}>
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </Panel>
    );
  const d = q.data;
  const change = (next: { enabled: boolean; steps: Record<string, boolean> }) => {
    setEnabled(next.enabled);
    setSteps(next.steps);
    save.mutate(next);
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
        {!d.canEdit && (
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
            disabled={!d.canEdit || save.isPending}
            onChange={(e) => change({ enabled: e.target.checked, steps })}
          />
          <span className="text-sm font-medium text-fg">Run release prep before a release ships</span>
        </label>
        <fieldset className="flex flex-col" disabled={!d.canEdit || save.isPending}>
          <legend className="text-sm font-medium text-fg">Steps</legend>
          {d.steps.map((s) => (
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
              </span>
            </label>
          ))}
        </fieldset>
        <ErrorBox error={save.error} />
      </div>
    </Panel>
  );
}
