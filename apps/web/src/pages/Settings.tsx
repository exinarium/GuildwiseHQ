import { useEffect, useState } from 'react';
import { useMe } from '../api/queries/auth.ts';
import { useReporting, useSetTimezone, useUpdateReporting } from '../api/queries/reporting.ts';
import { Button, ErrorBox, PageHeader, Panel, Select, Spinner, TextInput } from '../components/ui.tsx';
import { browserTimeZone, timeZoneOptions } from '../lib/timezone.ts';

/** Settings: your time zone, and how your BA reports to you (routing and the daily floor report). */
export function Settings() {
  const me = useMe();
  const reporting = useReporting();
  const setZone = useSetTimezone();
  const update = useUpdateReporting();
  const zone = reporting.data?.timezone ?? me.data?.user.timezone ?? null;
  const [dailyAt, setDailyAt] = useState('08:00');
  useEffect(() => {
    if (reporting.data) setDailyAt(reporting.data.dailyAt);
  }, [reporting.data]);

  if (reporting.isPending) return <Spinner label="Loading settings" />;
  const detected = browserTimeZone();
  const prefs = reporting.data;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      <PageHeader title="Settings" sub="Your time zone and how your BA reports to you." />
      <ErrorBox error={reporting.error ?? setZone.error ?? update.error} />

      <Panel>
        <h2 className="text-sm font-semibold">Your time zone</h2>
        <p className="mt-1 text-xs text-zinc-500">
          The daily floor report is posted at {prefs?.dailyAt} on your clock. We took it from your browser the
          first time you signed in. Until a zone is set, reports use UTC.
        </p>
        <div className="mt-2 flex flex-wrap items-end gap-2">
          <Select
            label="Time zone"
            data-testid="timezone"
            value={zone ?? ''}
            onChange={(e) => e.target.value && setZone.mutate(e.target.value)}
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
            <Button data-testid="use-browser-zone" onClick={() => setZone.mutate(detected)}>
              Use this browser's zone ({detected})
            </Button>
          )}
        </div>
      </Panel>

      <Panel>
        <h2 className="text-sm font-semibold">Your BA reports to you</h2>
        <p className="mt-1 text-xs text-zinc-500">
          With routing on, what agents raise goes to your BA first. Urgent blocking questions and approvals
          still reach you at once (the BA adds context afterwards), and anything the BA has not looked at
          within ten minutes reaches you unchanged.
        </p>
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            data-testid="route-via-ba"
            className="mt-0.5"
            checked={prefs?.routeViaBa ?? true}
            disabled={!prefs?.canEdit || update.isPending}
            onChange={(e) => update.mutate({ routeViaBa: e.target.checked })}
          />
          <span>
            Route agent-raised items through the BA first
            <span className="block text-xs text-zinc-500">
              Off: everything lands on your desk as it is raised.
            </span>
          </span>
        </label>
        <form
          className="mt-3 flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            update.mutate({ dailyAt });
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
        <p className="mt-2 text-xs text-zinc-500">
          Urgent notices are never held for this time; they reach you at any hour.
        </p>
      </Panel>
    </div>
  );
}
