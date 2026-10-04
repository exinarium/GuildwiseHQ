import type { RegressionPlatform } from '@aom/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { useRegression } from '../api/queries/testing.ts';
import { Button, Dialog, ErrorBox, Select } from './ui.tsx';

export function RegressionDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<RegressionPlatform>('web');
  const run = useRegression(projectId);
  return (
    <>
      <Button data-testid="regression-open" onClick={() => setOpen(true)}>
        Run regression
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) run.reset();
        }}
        title="Run regression"
        description="Queues a regression card per platform for the testers."
      >
        <div className="flex flex-col gap-3">
          <Select
            label="Platform"
            value={platform}
            onChange={(e) => setPlatform(e.target.value as RegressionPlatform)}
            data-testid="regression-platform"
          >
            <option value="web">Web</option>
            <option value="mobile">Mobile</option>
            <option value="both">Both</option>
          </Select>
          <ErrorBox error={run.error} />
          {run.data && (
            <ul data-testid="regression-created" className="text-sm">
              {run.data.cards.map((c) => (
                <li key={c.id}>
                  Created{' '}
                  <Link to={`/cards/${c.id}`} className="font-medium underline">
                    {c.ref}
                  </Link>{' '}
                  ({c.platform})
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-end gap-2">
            <Button onClick={() => setOpen(false)}>Close</Button>
            <Button
              variant="primary"
              data-testid="regression-run"
              disabled={run.isPending}
              onClick={() => run.mutate({ platform })}
            >
              Run
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
