import { useEffect, useState } from 'react';
import { useInterest, useResyncInterestTaste, useSaveInterestTaste } from '../../api/queries/interests.ts';
import { Button, ErrorBox, Panel, Spinner, useToast } from '../ui.tsx';
import { TasteRulesEditor } from './TasteRulesEditor.tsx';

/**
 * Taste rules built into the interest: the explicit rules (they come first and win on a conflict, mirrored to the
 * managed section of `taste.md`) and, read-only, what your ratings taught it.
 */
export function TasteTab({ interestId, canManage }: { interestId: string; canManage: boolean }) {
  const detail = useInterest(interestId);
  const save = useSaveInterestTaste();
  const resync = useResyncInterestTaste();
  const toast = useToast();
  const [rules, setRules] = useState<string[] | null>(null);
  useEffect(() => {
    if (detail.data && rules === null) setRules(detail.data.taste.rules);
  }, [detail.data, rules]);
  if (!detail.data || rules === null) return detail.error ? <ErrorBox error={detail.error} /> : <Spinner />;
  const t = detail.data.taste;
  const dirty = JSON.stringify(rules) !== JSON.stringify(t.rules);
  return (
    <div className="flex flex-col gap-4" data-testid="taste-tab">
      <Panel
        title="Explicit rules"
        actions={
          <span className="text-xs text-subtle" data-testid="taste-mirror-status">
            {t.hasVault
              ? `Mirrored to taste.md, version ${t.version}`
              : 'No vault yet: the rules reach the curators through their brief only'}
          </span>
        }
      >
        <p className="mb-3 text-sm text-muted">
          Rules the curators follow first. They win over what your ratings suggest.
        </p>
        <TasteRulesEditor rules={rules} onChange={setRules} disabled={!canManage} />
        <ErrorBox error={save.error ?? resync.error} />
        {canManage && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={!dirty}
              loading={save.isPending}
              data-testid="taste-save"
              onClick={() =>
                save.mutate(
                  { id: interestId, rules },
                  { onSuccess: () => toast.success('Taste rules saved') },
                )
              }
            >
              Save rules
            </Button>
            <Button
              loading={resync.isPending}
              title="Write the saved rules to taste.md in the vault again"
              data-testid="taste-resync"
              onClick={() =>
                resync.mutate(interestId, { onSuccess: () => toast.success('Rules sent to taste.md again') })
              }
            >
              Resync taste.md
            </Button>
          </div>
        )}
      </Panel>
      <Panel title="From your ratings" data-testid="taste-ratings">
        <p className="mb-2 text-sm text-muted">
          Read only, newest first. They are written to taste.md as you rate.
        </p>
        {t.ratingLines.length === 0 ? (
          <p className="text-sm text-subtle">No ratings yet.</p>
        ) : (
          <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto text-sm">
            {t.ratingLines.map((l) => (
              <li key={l} className="[overflow-wrap:anywhere]">
                {l.replace(/^- /, '')}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
