import type { CardApproval, CardDetailResponse, ProjectDetailResponse } from '@aom/shared';
import { useSetCardDesignGate } from '../api/queries/cards.ts';
import { useSetDesignGate } from '../api/queries/projects.ts';
import { Badge, ErrorBox, Panel } from './ui.tsx';

/** A checkbox row with a tap target of at least 44 px (touch). */
const TOUCH_LABEL = 'flex min-h-11 cursor-pointer items-center gap-3 py-2 text-sm text-fg';
const TOUCH_BOX = 'size-5 shrink-0';

/**
 * Lean team (`code` version 7) project setting: every card stops after Investigate & design and waits for the owner's
 * approval of the design report before Build. Off by default; a high-risk design always stops.
 */
export function DesignGatePanel({
  projectId,
  project,
  canChange,
}: {
  projectId: string;
  project: ProjectDetailResponse['project'];
  canChange: boolean;
}) {
  const set = useSetDesignGate(projectId);
  if (project.leanTeam !== true) return null;
  const on = project.designGate === true;
  return (
    <Panel data-testid="design-gate-panel">
      <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-fg">
        Design gate
        <Badge tone="brand">
          <span data-testid="design-gate-state">{on ? 'Every design' : 'Off'}</span>
        </Badge>
      </h2>
      <p className="mb-3 text-sm text-muted">
        After Investigate & design the card waits for you to read the architect's design report and approve it
        before Build starts, or return it to the architect with a note. High-risk designs always stop here.
      </p>
      <label className={TOUCH_LABEL}>
        <input
          type="checkbox"
          className={TOUCH_BOX}
          checked={on}
          disabled={!canChange || set.isPending}
          data-testid="design-gate-on"
          onChange={(e) => set.mutate(e.target.checked)}
        />
        <span>Stop every card after the design for my approval</span>
      </label>
      {!canChange && (
        <p className="mt-2 text-sm text-subtle" data-testid="design-gate-readonly">
          Only the project Owner and the organization's Owners and Admins can change this setting.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}

/**
 * The design gate switch of one card (card page). It can only be switched on once the card has a design report and
 * before Build has started; the server's reason is shown when it cannot.
 */
export function CardDesignGateSwitch({
  cardId,
  gate,
}: {
  cardId: string;
  gate: NonNullable<CardDetailResponse['designGate']>;
}) {
  const set = useSetCardDesignGate(cardId);
  const blocked = !gate.on && gate.refusal !== null;
  return (
    <Panel title="Design gate for this card" data-testid="card-design-gate">
      <label className={TOUCH_LABEL}>
        <input
          type="checkbox"
          className={TOUCH_BOX}
          checked={gate.on}
          disabled={!gate.canChange || blocked || set.isPending}
          data-testid="card-design-gate-on"
          onChange={(e) => set.mutate(e.target.checked)}
        />
        <span>Stop this card after the design for the owner's approval</span>
      </label>
      {blocked && gate.refusal && (
        <p className="text-sm text-subtle" data-testid="card-design-gate-refusal">
          {gate.refusal.message}
        </p>
      )}
      {gate.required && gate.reasonText && (
        <p className="text-sm text-muted" data-testid="card-design-gate-reason">
          The design gate applies: {gate.reasonText}.
        </p>
      )}
      <ErrorBox error={set.error} />
    </Panel>
  );
}

/**
 * The design gate on the approval panel: the existing design report in place of a diff. The report scrolls inside the
 * panel, so the buttons stay reachable while the soft keyboard is open for the return note.
 */
export function ApprovalDesign({
  design,
  defaultOpen,
}: {
  design: NonNullable<CardApproval['design']>;
  defaultOpen: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 text-sm" data-testid="approval-design">
      {design.reasonText && (
        <p className="text-muted" data-testid="approval-design-reason">
          Why the design stops here: {design.reasonText}.
        </p>
      )}
      {design.highRiskPaths.length > 0 && (
        <div data-testid="approval-design-paths">
          <p className="font-medium text-fg">High-risk paths</p>
          <ul className="list-inside list-disc text-muted">
            {design.highRiskPaths.map((p) => (
              <li key={p} className="break-all font-mono text-xs">
                {p}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="text-muted" data-testid="approval-design-summary">
        {design.summary}
      </p>
      <p className="break-all font-mono text-xs text-subtle" data-testid="approval-design-path">
        {design.reportPath}
        {design.commit ? ` @ ${design.commit.slice(0, 10)}` : ''}
      </p>
      {design.text ? (
        <details open={defaultOpen} className="rounded border border-border">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium text-fg">
            Design report
          </summary>
          <pre
            className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words px-3 pb-3 text-xs text-fg"
            data-testid="approval-design-text"
          >
            {design.text}
          </pre>
        </details>
      ) : (
        <p className="text-xs text-subtle" data-testid="approval-design-no-text">
          The full report is on the card branch at the path above.
        </p>
      )}
      {design.cardBrief && (
        <details className="rounded border border-border">
          <summary className="flex min-h-11 cursor-pointer items-center px-3 font-medium text-fg">
            Card Brief
          </summary>
          <p className="max-h-[30vh] overflow-auto whitespace-pre-wrap px-3 pb-3 text-muted">
            {design.cardBrief}
          </p>
        </details>
      )}
    </div>
  );
}
