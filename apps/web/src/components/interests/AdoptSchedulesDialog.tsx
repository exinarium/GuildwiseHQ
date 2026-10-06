import { useEffect, useState } from 'react';
import { useAdopt, useAdoptable } from '../../api/queries/interests.ts';
import { describeCron } from '../../lib/feeds.ts';
import { Button, Dialog, ErrorBox, Spinner } from '../ui.tsx';

/** Turns existing feed schedules into interests without rewriting their templates. */
export function AdoptSchedulesDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const list = useAdoptable(open);
  const adopt = useAdopt();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (list.data && !adopt.data) setPicked(new Set(list.data.map((s) => s.id)));
  }, [list.data, adopt.data]);
  const results = new Map((adopt.data?.results ?? []).map((r) => [r.scheduleId, r]));
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          adopt.reset();
          onClose();
        }
      }}
      title="Adopt feed schedules"
      description="Each schedule becomes an interest; its template is left as it is until you edit the interest."
    >
      <div className="flex flex-col gap-3" data-testid="adopt-dialog">
        {list.isPending && <Spinner />}
        <ErrorBox error={list.error ?? adopt.error} />
        {list.data?.length === 0 && <p className="text-sm text-subtle">Nothing left to adopt.</p>}
        <ul className="flex flex-col gap-2">
          {list.data?.map((s) => {
            const r = results.get(s.id);
            return (
              <li key={s.id} className="flex items-start gap-2 text-sm" data-testid={`adopt-row-${s.name}`}>
                <input
                  type="checkbox"
                  id={`adopt-${s.id}`}
                  className="mt-1"
                  checked={picked.has(s.id)}
                  disabled={!!r}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    setPicked(next);
                  }}
                />
                <label htmlFor={`adopt-${s.id}`} className="min-w-0 flex-1">
                  <span className="font-medium">{s.name}</span>{' '}
                  <span className="text-subtle">
                    {s.projectKey} · {describeCron(s.cron)} ({s.timezone}){s.topic ? ` · ${s.topic}` : ''}
                    {s.enabled ? '' : ' · paused'}
                  </span>
                  {r && (
                    <span
                      className={r.error ? 'block text-danger' : 'block text-success'}
                      data-testid="adopt-result"
                    >
                      {r.error ? r.error : 'Adopted'}
                    </span>
                  )}
                </label>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{adopt.data ? 'Close' : 'Cancel'}</Button>
          {!adopt.data && (
            <Button
              variant="primary"
              data-testid="adopt-submit"
              disabled={adopt.isPending || picked.size === 0}
              onClick={() => adopt.mutate([...picked])}
            >
              Adopt selected
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
