import type { ProjectDetailResponse } from '@aom/shared';
import { useState } from 'react';
import { useSetConcurrencyCap } from '../api/queries/projects.ts';
import { Badge, Button, ErrorBox, Panel, TextInput } from './ui.tsx';

/**
 * "Limit simultaneous shifts": an optional cap on how many shifts may run at once on this project, whatever the number
 * of agents allowed on it (docs/design/restructure.md decision 11). Off by default; any project member can change it.
 */
export function ConcurrencyCapPanel({
  projectId,
  project,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
}) {
  const set = useSetConcurrencyCap(projectId);
  const cap = project.maxConcurrentShifts ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (cap === null ? '' : String(cap));
  const parsed = Number(text);
  const valid = Number.isInteger(parsed) && parsed >= 1 && parsed <= 50;
  const dirty = valid && parsed !== cap;

  return (
    <Panel>
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">
        Simultaneous shifts
        <Badge tone={cap === null ? 'neutral' : 'brand'}>
          <span data-testid="concurrency-state">{cap === null ? 'No limit' : `At most ${cap} at once`}</span>
        </Badge>
      </h2>
      <p className="text-sm text-muted">
        By default every agent allowed on this project may work it at the same time. Set a limit to keep the
        project from taking over your agents (or your budget): once that many shifts run on it, its other
        cards wait in the queue.
      </p>
      <form
        aria-label="Simultaneous shifts"
        className="mt-3 flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) set.mutate(parsed, { onSuccess: () => setDraft(null) });
        }}
      >
        <div className="w-40">
          <TextInput
            label="Most shifts at once"
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            placeholder="No limit"
            value={text}
            onChange={(e) => setDraft(e.target.value)}
            error={text !== '' && !valid ? 'Enter a whole number from 1 to 50' : undefined}
            data-testid="concurrency-input"
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={!dirty || set.isPending}
          data-testid="concurrency-save"
        >
          Save limit
        </Button>
        {cap !== null && (
          <Button
            disabled={set.isPending}
            data-testid="concurrency-clear"
            onClick={() => set.mutate(null, { onSuccess: () => setDraft(null) })}
          >
            Remove limit
          </Button>
        )}
      </form>
      <ErrorBox error={set.error} />
    </Panel>
  );
}
