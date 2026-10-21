import type { SetupStateDto } from '@aom/shared';
import { useState } from 'react';
import { usePreviewSetup, usePublishSetup } from '../../api/queries/deploy-setup.ts';
import { Button, Callout, ErrorBox } from '../ui.tsx';

/**
 * "An improved version of these steps is available" (design v2): Guildwise's generator changed since these scripts were made.
 * Nothing changes by itself; updating writes the same setup again with the newer generator and needs the Owner's approval.
 */
export function ImprovedSteps({ projectId, s }: { projectId: string; s: SetupStateDto }) {
  const preview = usePreviewSetup(projectId);
  const publish = usePublishSetup(projectId);
  const [done, setDone] = useState(false);
  const run = () =>
    preview.mutate(
      { setup: s.current.setup },
      {
        onSuccess: (p) => {
          if (!p.ok || !p.hash) return;
          publish.mutate({ setup: s.current.setup, setupHash: p.hash }, { onSuccess: () => setDone(true) });
        },
      },
    );
  return (
    <Callout
      tone="info"
      title="An improved version of these steps is available"
      data-testid="setup-improved"
      actions={
        s.canEdit && !done ? (
          <Button
            size="sm"
            variant="primary"
            onClick={run}
            loading={preview.isPending || publish.isPending}
            data-testid="setup-improved-update"
          >
            Update the steps
          </Button>
        ) : undefined
      }
    >
      {done
        ? 'Saved. The new version of the steps needs the Owner’s approval (and a try-out) before it is used.'
        : 'Your steps were made by an older version of Guildwise. Updating keeps your choices and changes only how the steps are written (for example how a failed update is undone). The Owner approves the new version before anything runs.'}
      {preview.data && !preview.data.ok && (
        <div className="mt-2 flex flex-col gap-1 text-sm" data-testid="setup-improved-issues">
          <p className="font-medium">These steps cannot be updated yet:</p>
          <ul className="list-disc pl-5">
            {preview.data.issues.map((i) => (
              <li key={i}>{plainSetupIssue(i, s)}</li>
            ))}
          </ul>
        </div>
      )}
      <ErrorBox error={preview.error ?? publish.error} />
    </Callout>
  );
}

/**
 * A problem the generator found, in words a person can act on. The one that shows up when an older setup is written again: its
 * health check uses the web address of the server, and that was never filled in (older versions did not ask).
 */
export function plainSetupIssue(issue: string, s: SetupStateDto): string {
  const m = /^(.+?): the health check uses the app address, but no app address is set$/.exec(issue);
  if (!m) return issue;
  const name = m[1] as string;
  const label = s.current.setup?.environments.find((e) => e.name === name)?.label ?? name;
  return `“${label}” has no web address yet, and its health check needs one. Press Edit on “${label}”, go to “Address Guildwise checks after an update” and enter the address people use to open the app (for example https://app.example.com).`;
}
