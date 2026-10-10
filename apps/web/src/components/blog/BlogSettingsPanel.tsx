import type { BlogSettings } from '@aom/shared';
import { useEffect, useState } from 'react';
import { useDigests, usePatchBlogSettings, useSendDigestTest } from '../../api/queries/blog.ts';
import { formatDateTime } from '../../lib/time.ts';
import { ConfirmDialog } from '../ui/ConfirmDialog.tsx';
import { Badge, Button, Callout, ErrorBox, Panel, TextInput, useToast } from '../ui.tsx';

const toLocalInput = (iso: string | null): string => (iso ? iso.slice(0, 10) : '');

/** The kill switch, the moderation mode (review period and hold) and the weekly digest of the platform blog. */
export function BlogSettingsPanel({ settings }: { settings: BlogSettings }) {
  const patch = usePatchBlogSettings();
  const toast = useToast();
  const [confirmOff, setConfirmOff] = useState(false);
  const [from, setFrom] = useState(toLocalInput(settings.autoPublishFrom));
  const [hold, setHold] = useState(String(settings.holdHours));
  useEffect(() => setFrom(toLocalInput(settings.autoPublishFrom)), [settings.autoPublishFrom]);
  useEffect(() => setHold(String(settings.holdHours)), [settings.holdHours]);

  const changed = from !== toLocalInput(settings.autoPublishFrom) || hold !== String(settings.holdHours);
  const saveModeration = () =>
    patch.mutate(
      {
        autoPublishFrom: from ? new Date(`${from}T00:00:00Z`).toISOString() : null,
        holdHours: Math.max(0, Math.min(168, Number.parseInt(hold, 10) || 0)),
      },
      { onSuccess: () => toast.success('Moderation settings saved') },
    );

  return (
    <div className="mb-5 flex flex-col gap-4" data-testid="blog-settings">
      {!settings.enabled && (
        <Callout tone="danger" title="The blog is switched off" role="alert" data-testid="blog-off-banner">
          Agents cannot create posts, nothing is published (by you or automatically), and no digest or social
          post goes out. Posts that are already public stay readable.
        </Callout>
      )}
      <Panel title="Blog switch and moderation">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={settings.enabled ? 'success' : 'danger'} data-testid="blog-state">
            {settings.enabled ? 'On' : 'Off'}
          </Badge>
          {settings.enabled ? (
            <Button variant="danger" onClick={() => setConfirmOff(true)} data-testid="blog-kill">
              Switch the blog off
            </Button>
          ) : (
            <Button
              variant="primary"
              loading={patch.isPending}
              onClick={() =>
                patch.mutate({ enabled: true }, { onSuccess: () => toast.success('The blog is on') })
              }
              data-testid="blog-enable"
            >
              Switch the blog on
            </Button>
          )}
          <span className="text-sm text-muted">
            The kill switch stops creating (the API answers 503) and publishing, the digest and social posts.
          </span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Auto-publish starts on"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            hint={
              settings.reviewAll
                ? 'Until this date you review every post. Empty: never auto-publish. Default: two weeks after the first post.'
                : 'From this date a clean post publishes by itself after the hold.'
            }
            data-testid="auto-from"
          />
          <TextInput
            label="Hold before auto-publish (hours)"
            type="number"
            min={0}
            max={168}
            value={hold}
            onChange={(e) => setHold(e.target.value)}
            hint="Posts with a content warning always wait for you."
            data-testid="hold-hours"
          />
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button variant="primary" disabled={!changed} loading={patch.isPending} onClick={saveModeration}>
            Save
          </Button>
          <span className="text-sm text-muted" data-testid="review-mode">
            {settings.reviewAll
              ? 'Mode: you review every post.'
              : `Mode: auto-publish after ${settings.holdHours} h.`}
          </span>
        </div>
        <ErrorBox error={patch.error} />
        <ConfirmDialog
          open={confirmOff}
          onOpenChange={setConfirmOff}
          title="Switch the blog off?"
          description="Agents will be refused when they create posts, and nothing is published, mailed or shared until you switch it on again."
          confirmLabel="Switch off"
          pending={patch.isPending}
          onConfirm={() =>
            patch.mutate(
              { enabled: false },
              {
                onSuccess: () => {
                  setConfirmOff(false);
                  toast.success('The blog is off');
                },
              },
            )
          }
        />
      </Panel>
      <DigestPanel settings={settings} />
    </div>
  );
}

function DigestPanel({ settings }: { settings: BlogSettings }) {
  const patch = usePatchBlogSettings();
  const digests = useDigests();
  const test = useSendDigestTest();
  const toast = useToast();
  return (
    <Panel title="Weekly digest">
      <p className="mb-3 text-sm text-muted">
        Mondays at 08:00 Africa/Johannesburg: new articles go to organization Owners (unless they opted out)
        and to everyone else who opted in. Nothing is sent in a week without new posts.
      </p>
      <label className="flex items-center gap-3 text-base text-fg">
        <input
          type="checkbox"
          className="size-5"
          checked={settings.digestEnabled}
          onChange={(e) => patch.mutate({ digestEnabled: e.target.checked })}
          data-testid="digest-enabled"
        />
        Send the weekly digest
      </label>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          loading={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (r) => toast.success(`Test digest sent to ${(r as { sentTo: string }).sentTo}`),
            })
          }
          data-testid="digest-test"
        >
          Send a test to me
        </Button>
      </div>
      <ErrorBox error={test.error} />
      {digests.data && digests.data.digests.length > 0 && (
        <table className="mt-4 w-full text-sm" data-testid="digest-history">
          <thead className="text-left text-xs text-subtle">
            <tr>
              <th className="py-1 font-medium">Digest</th>
              <th className="py-1 font-medium">Result</th>
              <th className="py-1 font-medium">Posts</th>
              <th className="py-1 font-medium">Recipients</th>
              <th className="py-1 font-medium">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {digests.data.digests.map((d) => (
              <tr key={d.digestId}>
                <td className="py-1.5 font-mono text-xs">{d.digestId}</td>
                <td className="py-1.5">
                  {d.state === 'skipped' ? `Skipped (${d.note ?? 'no posts'})` : d.state}
                </td>
                <td className="py-1.5">{d.posts}</td>
                <td className="py-1.5">{d.recipients}</td>
                <td className="py-1.5 text-muted">{formatDateTime(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
