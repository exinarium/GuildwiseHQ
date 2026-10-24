import type { OffboardingReport, OffboardingStep } from '@aom/shared';
import { Check, CircleDashed, Clock3, Minus } from 'lucide-react';
import { Button, Dialog } from '../ui.tsx';

const ICON: Record<OffboardingStep['status'], typeof Check> = {
  done: Check,
  nothing: Minus,
  kept: CircleDashed,
  flagged: Clock3,
};

/** The offboarding checklist, as it will run (before) or as it ran (after). */
export function OffboardingChecklist({ steps, testId }: { steps: OffboardingStep[]; testId: string }) {
  return (
    <ul className="space-y-1.5 text-sm" data-testid={testId}>
      {steps.map((s) => {
        const Icon = ICON[s.status];
        return (
          <li
            key={s.key}
            className={`flex items-start gap-2 ${s.status === 'nothing' ? 'text-subtle' : 'text-muted'}`}
          >
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>
              <strong className="text-fg">{s.label}.</strong> {s.detail}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** What the removal did, step by step, shown once the member is out. */
export function OffboardingReportDialog({
  report,
  onClose,
}: {
  report: OffboardingReport | null;
  onClose: () => void;
}) {
  return (
    <Dialog
      open={!!report}
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`${report?.userName ?? 'The member'} was removed`}
      description="This is what the offboarding checklist did. It is on the audit log."
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      {report && (
        <div className="flex flex-col gap-3" data-testid="offboarding-report">
          <OffboardingChecklist steps={report.steps} testId="offboarding-steps" />
          {report.notes.length > 0 && (
            <ul
              className="space-y-1 rounded-control bg-sunken p-3 text-sm text-muted"
              data-testid="offboarding-notes"
            >
              {report.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Dialog>
  );
}
