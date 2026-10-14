import { useBriefingPreference, useSetBriefingPreference } from '../api/queries/reporting.ts';
import { ErrorBox, Panel, useToast } from './ui.tsx';

/** Settings: the person's own switch for the Monday briefing mail (on unless they turned it off). */
export function BriefingToggle() {
  const briefing = useBriefingPreference();
  const setBriefing = useSetBriefingPreference();
  const toast = useToast();
  return (
    <Panel>
      <h2 className="text-lg font-semibold text-fg">Monday briefing</h2>
      <p className="mt-1 text-sm text-muted">
        One email every Monday at 08:00 (organization time) with what was finished, what waits on you, what is
        blocked and, for Owners and Admins, spend and value.
      </p>
      <label className="mt-4 flex items-start gap-3 text-base text-fg">
        <input
          type="checkbox"
          data-testid="weekly-briefing"
          className="mt-0.5 size-5"
          checked={briefing.data?.enabled ?? true}
          disabled={briefing.isPending || setBriefing.isPending}
          onChange={(e) =>
            setBriefing.mutate(e.target.checked, {
              onSuccess: () =>
                toast.success(
                  e.target.checked ? 'You will get the Monday briefing' : 'Briefing switched off',
                ),
            })
          }
        />
        <span>Email me the Monday briefing</span>
      </label>
      <ErrorBox error={briefing.error ?? setBriefing.error} />
    </Panel>
  );
}
