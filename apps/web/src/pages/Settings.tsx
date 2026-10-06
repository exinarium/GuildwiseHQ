import { useEffect, useState } from 'react';
import { useMe } from '../api/queries/auth.ts';
import { useReporting, useSetTimezone, useUpdateReporting } from '../api/queries/reporting.ts';
import { UserAvatar } from '../components/Face.tsx';
import { AvatarPicker } from '../components/profile/AvatarPicker.tsx';
import { TwoFactorPanel } from '../components/security/TwoFactorPanel.tsx';
import {
  Button,
  ErrorBox,
  PageHeader,
  PageSkeleton,
  Panel,
  Select,
  TextInput,
  useToast,
} from '../components/ui.tsx';
import { browserTimeZone, timeZoneOptions } from '../lib/timezone.ts';

/** Settings: your time zone, and how your BA reports to you (routing and the daily floor report). */
export function Settings() {
  const me = useMe();
  const reporting = useReporting();
  const setZone = useSetTimezone();
  const update = useUpdateReporting();
  const toast = useToast();
  const [picking, setPicking] = useState(false);
  const zone = reporting.data?.timezone ?? me.data?.user.timezone ?? null;
  const [dailyAt, setDailyAt] = useState('08:00');
  const [route, setRoute] = useState(true);
  useEffect(() => {
    if (reporting.data) {
      setDailyAt(reporting.data.dailyAt);
      setRoute(reporting.data.routeViaBa);
    }
  }, [reporting.data]);

  if (reporting.isPending)
    return (
      <div className="mx-auto max-w-2xl">
        <PageSkeleton label="Loading settings" />
      </div>
    );
  const detected = browserTimeZone();
  const prefs = reporting.data;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <PageHeader title="Settings" sub="Your time zone and how your BA reports to you." />
      <ErrorBox error={reporting.error ?? setZone.error ?? update.error} />

      {me.data?.user && (
        <Panel>
          <div className="flex flex-wrap items-center gap-4">
            <UserAvatar user={me.data.user} size={64} />
            <div className="min-w-0 flex-1">
              <h2 className="text-lg font-semibold text-fg">Your picture</h2>
              <p className="text-sm text-muted">
                A cartoon face, a photo or an image of your own. It shows in the sidebar, the account menu and
                on the answers you give at the desk.
              </p>
            </div>
            <Button data-testid="change-picture" onClick={() => setPicking(true)}>
              Change picture
            </Button>
          </div>
          <AvatarPicker
            open={picking}
            onOpenChange={setPicking}
            name={me.data.user.displayName}
            current={me.data.user.avatar ?? null}
          />
        </Panel>
      )}

      <TwoFactorPanel />

      <Panel>
        <h2 className="text-lg font-semibold text-fg">Your time zone</h2>
        <p className="mt-1 mb-3 text-sm text-muted">
          The daily floor report is posted at {prefs?.dailyAt} on your clock. We took it from your browser the
          first time you signed in. Until a zone is set, reports use UTC.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Select
            label="Time zone"
            data-testid="timezone"
            value={zone ?? ''}
            onChange={(e) =>
              e.target.value &&
              setZone.mutate(e.target.value, { onSuccess: () => toast.success('Time zone saved') })
            }
            disabled={setZone.isPending}
          >
            {!zone && <option value="">Not set (UTC)</option>}
            {timeZoneOptions(zone).map((z) => (
              <option key={z} value={z}>
                {z}
              </option>
            ))}
          </Select>
          {detected && detected !== zone && (
            <Button
              data-testid="use-browser-zone"
              onClick={() => setZone.mutate(detected, { onSuccess: () => toast.success('Time zone saved') })}
            >
              Use this browser's zone ({detected})
            </Button>
          )}
        </div>
      </Panel>

      <Panel>
        <h2 className="text-lg font-semibold text-fg">Your BA reports to you</h2>
        <p className="mt-1 text-sm text-muted">
          With routing on, what agents raise goes to your BA first. Urgent blocking questions and approvals
          still reach you at once (the BA adds context afterwards), and anything the BA has not looked at
          within ten minutes reaches you unchanged.
        </p>
        <label className="mt-4 flex items-start gap-3 text-base text-fg">
          <input
            type="checkbox"
            data-testid="route-via-ba"
            className="mt-0.5 size-5"
            checked={route}
            disabled={!prefs?.canEdit}
            onChange={(e) => {
              setRoute(e.target.checked);
              update.mutate(
                { routeViaBa: e.target.checked },
                {
                  onSuccess: () =>
                    toast.success(e.target.checked ? 'Routing through the BA is on' : 'Routing is off'),
                },
              );
            }}
          />
          <span>
            Route agent-raised items through the BA first
            <span className="block text-sm text-muted">
              Off: everything lands on your desk as it is raised.
            </span>
          </span>
        </label>
        <form
          className="mt-4 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ dailyAt }, { onSuccess: () => toast.success('Report time saved') });
          }}
        >
          <TextInput
            label="Daily floor report at"
            type="time"
            data-testid="daily-at"
            value={dailyAt}
            onChange={(e) => setDailyAt(e.target.value)}
            disabled={!prefs?.canEdit}
          />
          <Button
            type="submit"
            variant="primary"
            disabled={!prefs?.canEdit || update.isPending || dailyAt === prefs?.dailyAt || !dailyAt}
          >
            Save time
          </Button>
        </form>
        <p className="mt-3 text-sm text-muted">
          Urgent notices are never held for this time; they reach you at any hour.
        </p>
      </Panel>
    </div>
  );
}
