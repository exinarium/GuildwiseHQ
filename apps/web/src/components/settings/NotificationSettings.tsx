import { PUSH_CATEGORIES, PUSH_CATEGORY_INFO, type PushPreferences } from '@aom/shared';
import { useEffect, useState } from 'react';
import { errorMessage } from '../../api/client.ts';
import { useMe } from '../../api/queries/auth.ts';
import {
  useInvalidatePushDevices,
  usePushConfig,
  usePushDevices,
  usePushPreferences,
  useSavePushPreferences,
  useSendPushTest,
} from '../../api/queries/push.ts';
import { currentEndpoint, enablePush, pushSupport, removeDevice } from '../../lib/push.ts';
import { Button, Callout, ErrorBox, Panel, useToast } from '../ui.tsx';

/** Settings: Web Push for this phone or computer. Permission is only asked from the button, never on load. */
export function NotificationSettings() {
  const me = useMe();
  const config = usePushConfig();
  const devices = usePushDevices();
  const prefs = usePushPreferences();
  const savePrefs = useSavePushPreferences();
  const refreshDevices = useInvalidatePushDevices();
  const test = useSendPushTest();
  const toast = useToast();
  const [here, setHere] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [allOrgs, setAllOrgs] = useState(true);
  const support = pushSupport();
  const manyOrgs = (me.data?.orgs?.length ?? 0) > 1;

  useEffect(() => {
    void currentEndpoint().then(setHere);
  }, []);

  const list = Array.isArray(devices.data?.devices) ? devices.data.devices : [];
  const thisDevice = list.find((d) => d.endpoint === here);

  const enable = async () => {
    if (!config.data?.publicKey) return;
    setBusy(true);
    setProblem(null);
    try {
      await enablePush(config.data.publicKey);
      setHere(await currentEndpoint());
      await refreshDevices();
      toast.success('Notifications are on for this device');
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string, endpoint: string) => {
    setRemoving(id);
    setProblem(null);
    try {
      await removeDevice(id, endpoint);
      setHere(await currentEndpoint());
      await refreshDevices();
      toast.success('Device removed');
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setRemoving(null);
    }
  };

  const save = (update: Parameters<typeof savePrefs.mutate>[0]) =>
    savePrefs.mutate({ ...update, ...(manyOrgs ? { allOrgs } : { allOrgs: true }) });
  const p: PushPreferences | undefined =
    prefs.data?.categories && prefs.data.quietHours ? prefs.data : undefined;

  return (
    <Panel>
      <h2 className="text-lg font-semibold text-fg">Notifications</h2>
      <p className="mt-1 text-sm text-muted">
        Get a push notification on your phone or computer when something needs you, even when the app is
        closed.
      </p>

      {config.data && !config.data.enabled && (
        <Callout tone="info" className="mt-4" data-testid="push-disabled">
          Push notifications are not set up on this server yet. An administrator has to add the push keys
          first.
        </Callout>
      )}

      {config.data?.enabled && support === 'needs-install' && (
        <Callout
          tone="info"
          title="Add Guildwise to your Home Screen first"
          className="mt-4"
          data-testid="push-ios-hint"
        >
          iPhone and iPad only allow notifications for apps on the Home Screen (iOS 16.4 or later). In Safari
          tap Share, then Add to Home Screen, then open Guildwise from its icon and come back here.
        </Callout>
      )}
      {config.data?.enabled && support === 'unsupported' && (
        <Callout tone="warning" className="mt-4" data-testid="push-unsupported">
          This browser cannot receive push notifications. Try Safari on an iPhone (installed to the Home
          Screen), Chrome on Android, or a recent desktop browser.
        </Callout>
      )}
      {config.data?.enabled && support === 'denied' && (
        <Callout tone="warning" className="mt-4" data-testid="push-denied">
          Notifications are blocked for this site. Allow them in the browser or phone settings, then reload
          this page.
        </Callout>
      )}

      {config.data?.enabled && support === 'ready' && (
        <div className="mt-4">
          {thisDevice ? (
            <p className="text-base text-fg" data-testid="push-this-device-on">
              Notifications are on for this device.
            </p>
          ) : (
            <Button variant="primary" loading={busy} onClick={enable} data-testid="push-enable">
              Enable notifications on this device
            </Button>
          )}
        </div>
      )}
      {problem && (
        <p role="alert" className="mt-3 text-sm text-danger">
          {problem}
        </p>
      )}

      <h3 className="mt-6 text-base font-semibold text-fg">Your devices</h3>
      {list.length === 0 ? (
        <p className="mt-1 text-sm text-muted">No device receives notifications yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line rounded-card border border-line" data-testid="push-devices">
          {list.map((d) => (
            <li key={d.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="truncate text-base text-fg">
                  {d.label}
                  {d.endpoint === here && <span className="ml-2 text-sm text-muted">(this device)</span>}
                </p>
                <p className="text-sm text-muted">
                  Added {new Date(d.createdAt).toLocaleDateString()}
                  {d.failureCount > 0
                    ? ` · ${d.failureCount} failed attempt${d.failureCount === 1 ? '' : 's'}`
                    : ''}
                </p>
              </div>
              <Button
                size="sm"
                aria-label={`Remove ${d.label}`}
                loading={removing === d.id}
                onClick={() => remove(d.id, d.endpoint)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <Button
          size="sm"
          disabled={list.length === 0 || test.isPending}
          loading={test.isPending}
          data-testid="push-test"
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (r) =>
                r.sent > 0
                  ? toast.success(`Test sent to ${r.sent} device${r.sent === 1 ? '' : 's'}`)
                  : toast.error('The test could not be delivered. Remove the device and enable it again.'),
            })
          }
        >
          Send a test notification
        </Button>
      </div>

      <h3 className="mt-6 text-base font-semibold text-fg">What to notify me about</h3>
      {p && (
        <ul className="mt-2 space-y-3" data-testid="push-categories">
          {PUSH_CATEGORIES.map((c) => (
            <li key={c}>
              <label className="flex items-start gap-3 text-base text-fg">
                <input
                  type="checkbox"
                  className="mt-0.5 size-5"
                  data-testid={`push-cat-${c}`}
                  checked={p.categories[c]}
                  disabled={savePrefs.isPending}
                  onChange={(e) => save({ categories: { [c]: e.target.checked } })}
                />
                <span>
                  {PUSH_CATEGORY_INFO[c].label}
                  <span className="block text-sm text-muted">{PUSH_CATEGORY_INFO[c].description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {p && (
        <div className="mt-6">
          <label className="flex items-start gap-3 text-base text-fg">
            <input
              type="checkbox"
              className="mt-0.5 size-5"
              data-testid="push-quiet-enabled"
              checked={p.quietHours.enabled}
              disabled={savePrefs.isPending}
              onChange={(e) => save({ quietHours: { ...p.quietHours, enabled: e.target.checked } })}
            />
            <span>
              Quiet hours
              <span className="block text-sm text-muted">
                In your own time zone. Only blocking questions and approvals come through.
              </span>
            </span>
          </label>
          {p.quietHours.enabled && (
            <div className="mt-3 flex items-center gap-3 pl-8">
              <label className="text-sm text-muted">
                From
                <input
                  type="time"
                  aria-label="Quiet hours start"
                  data-testid="push-quiet-start"
                  className="ml-2 h-11 rounded-control border border-control bg-surface px-2 text-base text-fg"
                  value={p.quietHours.start}
                  onChange={(e) =>
                    e.target.value && save({ quietHours: { ...p.quietHours, start: e.target.value } })
                  }
                />
              </label>
              <label className="text-sm text-muted">
                To
                <input
                  type="time"
                  aria-label="Quiet hours end"
                  data-testid="push-quiet-end"
                  className="ml-2 h-11 rounded-control border border-control bg-surface px-2 text-base text-fg"
                  value={p.quietHours.end}
                  onChange={(e) =>
                    e.target.value && save({ quietHours: { ...p.quietHours, end: e.target.value } })
                  }
                />
              </label>
            </div>
          )}
        </div>
      )}

      {manyOrgs && (
        <label className="mt-6 flex items-start gap-3 text-base text-fg">
          <input
            type="checkbox"
            className="mt-0.5 size-5"
            data-testid="push-all-orgs"
            checked={allOrgs}
            onChange={(e) => setAllOrgs(e.target.checked)}
          />
          <span>
            Use these choices for all my organizations
            <span className="block text-sm text-muted">
              Switch off to change them only for {me.data?.activeOrg?.name ?? 'this organization'}.
            </span>
          </span>
        </label>
      )}
      <ErrorBox error={config.error ?? devices.error ?? prefs.error ?? savePrefs.error} />
    </Panel>
  );
}
