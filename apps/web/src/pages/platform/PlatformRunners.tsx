import { Download } from 'lucide-react';
import { useRunnerUpdateSettings, useSetRunnerUpdatesPaused } from '../../api/queries/platform.ts';
import { Badge, Button, Callout, ErrorBox, ListSkeleton, PageHeader, Panel } from '../../components/ui.tsx';
import { formatDateTime } from '../../lib/time.ts';

/** `/platform/runners`: the runner release this server offers and the switch that pauses automatic runner updates. */
export function PlatformRunners() {
  const settings = useRunnerUpdateSettings();
  const toggle = useSetRunnerUpdatesPaused();
  return (
    <div>
      <PageHeader
        title="Runners"
        sub="Runners check this server once a day and update themselves when it offers a newer version."
      />
      {settings.isPending && <ListSkeleton label="Loading" rows={1} />}
      {settings.isError && <ErrorBox error={settings.error} onRetry={() => settings.refetch()} />}
      {settings.data && (
        <Panel title="Automatic runner updates" className="max-w-2xl">
          <div className="flex flex-col gap-3" data-testid="runner-updates">
            <p className="flex items-center gap-2 text-sm text-fg">
              <Download aria-hidden="true" className="size-4 text-muted" />
              {settings.data.latestVersion ? (
                <span>
                  Version offered to runners: <strong>{settings.data.latestVersion}</strong>
                </span>
              ) : (
                <span>This server has no runner release published.</span>
              )}
              <Badge tone={settings.data.paused ? 'warning' : 'success'} data-testid="runner-updates-state">
                {settings.data.paused ? 'Paused' : 'On'}
              </Badge>
            </p>
            {settings.data.paused ? (
              <Callout tone="warning" title="Runners are not updating">
                Runners keep the version they have until updates are resumed. A runner that is waiting to
                restart into a new version stays on its current one.
                {settings.data.updatedAt && ` Paused ${formatDateTime(settings.data.updatedAt)}.`}
              </Callout>
            ) : (
              <p className="text-sm text-muted">
                Pause updates if a release turns out to be bad. Runners that already updated are not changed;
                runners that have not yet are told to stay where they are.
              </p>
            )}
            <div>
              <Button
                variant={settings.data.paused ? 'primary' : 'secondary'}
                loading={toggle.isPending}
                onClick={() => toggle.mutate(!settings.data.paused)}
                data-testid="runner-updates-toggle"
              >
                {settings.data.paused ? 'Resume automatic updates' : 'Pause automatic updates'}
              </Button>
            </div>
            <ErrorBox error={toggle.error} />
          </div>
        </Panel>
      )}
    </div>
  );
}
