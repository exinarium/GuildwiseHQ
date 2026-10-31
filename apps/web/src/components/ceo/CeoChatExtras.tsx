import type { CeoChatStateDto, CeoCorrectionDto, CeoPermissionDto, DeskItemDto } from '@aom/shared';
import { ShieldQuestion } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  useAnswerPermission,
  useCeoRedo,
  useConfirmTurn,
  useDecideQueuedTurn,
  useEditCorrection,
} from '../../api/queries/ceo-chat.ts';
import { useRelease, useReleaseQueue } from '../../api/queries/delivery.ts';
import { useCanManageOrg } from '../../lib/orgRole.ts';
import { Button, Callout, ErrorBox, TextInput } from '../ui.tsx';
import { UndoButton } from './UndoButton.tsx';
import { Reword } from '../../components/Reword.tsx';

/** The full-power status line (chat header and CEO Overview). */
export function fullPowerText(fp: CeoChatStateDto['fullPower'], ceoName: string): string {
  const ws = fp.workstationName ?? 'its workstation';
  switch (fp.state) {
    case 'on':
      return `Full power is on: ${ceoName} works as you on ${ws}.`;
    case 'off':
      return `Full power is off on ${ws}: run \`guildwise-runner ceo full-power on\` there. Until then ${ceoName} answers with restricted tools.`;
    case 'unknown':
      return `${ws} is offline, so full power cannot be checked. Messages wait until it is back.`;
    default:
      return `Add a workstation to talk to ${ceoName}.`;
  }
}

export function FullPowerLine({
  fullPower,
  ceoName,
}: {
  fullPower: CeoChatStateDto['fullPower'];
  ceoName: string;
}) {
  const tone = fullPower.state === 'on' ? 'text-success-soft-fg' : 'text-warning-soft-fg';
  return (
    <p className={`text-xs ${tone}`} data-testid="full-power" data-state={fullPower.state}>
      {fullPowerText(fullPower, ceoName)}
    </p>
  );
}

/** Messages that wait for the workstation; a stale one asks "Send / Drop". */
export function QueuedBanner({
  state,
  notice,
}: {
  state: CeoChatStateDto | undefined;
  /** The workstation name from a live `chat.queued` message, before the state has refetched. */
  notice: { workstationName?: string } | null;
}) {
  const decide = useDecideQueuedTurn();
  const queued = state?.queued ?? [];
  if (queued.length === 0 && !notice) return null;
  const ws = notice?.workstationName ?? state?.workstation?.name ?? 'its workstation';
  const name = state?.agentName ?? 'The CEO';
  return (
    <div className="flex flex-col gap-2" data-testid="ceo-queued">
      <Callout tone="info" role="status">
        Queued: {name} answers when {ws} is back.
      </Callout>
      {queued
        .filter((q) => q.stale)
        .map((q) => (
          <Callout
            key={q.turnId}
            tone="warning"
            role="alert"
            data-testid="ceo-queued-stale"
            actions={
              <>
                <Button
                  size="sm"
                  variant="primary"
                  loading={decide.isPending}
                  onClick={() => decide.mutate({ turnId: q.turnId, decision: 'send' })}
                >
                  Send
                </Button>
                <Button
                  size="sm"
                  loading={decide.isPending}
                  onClick={() => decide.mutate({ turnId: q.turnId, decision: 'drop' })}
                >
                  Drop
                </Button>
              </>
            }
          >
            This waited 3 days, still want it? "{q.body.slice(0, 80)}"
          </Callout>
        ))}
      <ErrorBox error={decide.error} />
    </div>
  );
}

function useCountdown(until: string): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
}

export const clock = (s: number): string => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** "Authorize this execution": the tool, the redacted input and the reason, with a countdown to the automatic Deny. */
export function PermissionCard({ p }: { p: CeoPermissionDto }) {
  const answer = useAnswerPermission();
  const left = useCountdown(p.expiresAt);
  return (
    <div
      className="rounded-control border border-warning-fill/50 bg-warning-soft p-3 text-sm text-warning-soft-fg"
      role="group"
      aria-label="Authorize this execution"
      data-testid="ceo-permission"
    >
      <p className="flex items-center gap-1.5 font-semibold">
        <ShieldQuestion aria-hidden="true" className="size-4" />
        Authorize this execution?
        {p.mode === 'order' && <span className="font-normal"> <Reword>{'(standing order: the turn does not wait)'}</Reword></span>}
      </p>
      <p className="mt-1">
        <span className="font-mono">{p.tool}</span>
        {p.reason ? `: ${p.reason}` : ''}
      </p>
      {p.input && (
        <pre className="mt-1 max-h-32 overflow-auto rounded-control bg-surface p-2 text-xs whitespace-pre-wrap text-fg">
          {p.input}
        </pre>
      )}
      <p className="mt-1 text-xs" data-testid="ceo-permission-left">
        {left > 0 ? `Denied automatically in ${clock(left)}.` : 'Timed out: denied.'}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {(
          [
            ['once', 'Authorize once'],
            ['turn', 'Authorize for this turn'],
          ] as const
        ).map(([decision, label]) => (
          <Button
            key={decision}
            size="sm"
            variant={decision === 'once' ? 'primary' : 'secondary'}
            loading={answer.isPending}
            onClick={() => answer.mutate({ askId: p.askId, decision })}
          >
            {label}
          </Button>
        ))}
        <Button
          size="sm"
          loading={answer.isPending}
          onClick={() => answer.mutate({ askId: p.askId, decision: 'deny' })}
        >
          Deny
        </Button>
      </div>
      <ErrorBox error={answer.error} />
    </div>
  );
}

/** An owner-turn recommendation: Approve or No, answered by the Owner's session and never by text. */
export function ConfirmationCard({ c }: { c: CeoChatStateDto['confirmations'][number] }) {
  const confirm = useConfirmTurn();
  const turnId = c.turnId;
  return (
    <div
      className="rounded-control border border-brand/25 bg-brand-soft p-3 text-sm text-brand-soft-fg"
      role="group"
      aria-label="Confirm"
      data-testid="ceo-confirmation"
    >
      <p className="font-semibold">{c.title}</p>
      {c.reason && <p className="mt-1">{c.reason}</p>}
      {turnId && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant="primary"
            loading={confirm.isPending}
            onClick={() => confirm.mutate({ turnId, actionId: c.actionId, approve: true })}
          >
            Approve
          </Button>
          <Button
            size="sm"
            loading={confirm.isPending}
            onClick={() => confirm.mutate({ turnId, actionId: c.actionId, approve: false })}
          >
            No
          </Button>
        </div>
      )}
      <ErrorBox error={confirm.error} />
    </div>
  );
}

/** "Noted: <rule>" with Edit, and Undo / Redo while the corrected action has one. */
export function CorrectionCard({ c }: { c: CeoCorrectionDto }) {
  const edit = useEditCorrection();
  const redo = useCeoRedo();
  const [editing, setEditing] = useState(false);
  const [rule, setRule] = useState(c.rule);
  const [redone, setRedone] = useState<string | null>(null);
  return (
    <div
      className="rounded-control border border-line bg-sunken p-3 text-sm text-fg"
      data-testid="ceo-correction"
    >
      {editing ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            edit.mutate({ id: c.id, rule }, { onSuccess: () => setEditing(false) });
          }}
        >
          <TextInput label="The rule" value={rule} onChange={(e) => setRule(e.target.value)} />
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="primary" loading={edit.isPending}>
              Save
            </Button>
            <Button size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
          <ErrorBox error={edit.error} />
        </form>
      ) : (
        <>
          <p>
            <strong>Noted:</strong> {c.rule}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {c.canUndo && c.actionId && <UndoButton actionId={c.actionId} what={c.rule} />}
            {c.canRedo && !redone && (
              <Button
                size="sm"
                loading={redo.isPending}
                onClick={() => redo.mutate(c.id, { onSuccess: (r) => setRedone(r.message) })}
              >
                Redo
              </Button>
            )}
            {redone && (
              <span role="status" className="text-sm text-muted">
                {redone}
              </span>
            )}
          </div>
          <ErrorBox error={redo.error} />
        </>
      )}
    </div>
  );
}

/** The desk's "authorize this execution" item: the same three buttons as the chat card. */
export function PermissionDeskItem({ item }: { item: DeskItemDto }) {
  const d = item.data;
  if (!d?.askId)
    return (
      <p className="mt-3 text-sm text-subtle" data-testid="ceo-permission-missing">
        This question can no longer be answered here.
      </p>
    );
  return (
    <div className="mt-3">
      <PermissionCard
        p={{
          askId: d.askId,
          deskItemId: item.id,
          turnId: d.turnId ?? '',
          mode: 'owner',
          tool: d.tool ?? 'a tool',
          input: d.input ?? '',
          reason: d.reason ?? '',
          askedAt: item.createdAt,
          expiresAt: d.expiresAt ?? new Date(Date.parse(item.createdAt) + 600_000).toISOString(),
        }}
      />
    </div>
  );
}

/**
 * The Deploy button of the CEO chat (docs/design/ceo-front-door.md 9.6): when the CEO asked for a release, or its call was
 * blocked, the release waits here for the Owner or an Admin. Release calls the same server path from YOUR session, with no
 * model involved; an environment with several servers asks which ones on the Deploys page.
 */
export function ReleaseCards() {
  const canManage = useCanManageOrg();
  const q = useReleaseQueue(canManage);
  const release = useRelease();
  const items = canManage ? (q.data ?? []) : [];
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="ceo-releases">
      {items.map((i) => (
        <div
          key={`${i.projectId}|${i.env}|${i.commit ?? ''}`}
          className="rounded-control border border-brand/25 bg-brand-soft p-3 text-sm text-brand-soft-fg"
          role="group"
          aria-label="Release"
          data-testid="ceo-release"
        >
          <p className="font-semibold">
            {i.projectKey} {i.env} is ready to release{i.commit ? ` (${i.commit.slice(0, 8)})` : ''}
          </p>
          <p className="mt-1">
            To {i.targets.map((t) => t.targetName).join(', ')}. The recipe is approved and the gate holds;
            nothing runs until you release it.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {i.targets.length === 1 ? (
              <Button
                size="sm"
                variant="primary"
                loading={release.isPending}
                disabled={!i.gateNow.satisfied}
                onClick={() => release.mutate(i.targets.map((t) => t.runId))}
              >
                Release
              </Button>
            ) : (
              <Link
                to="/releases"
                className="inline-flex h-8 items-center rounded-control bg-brand px-3 text-sm font-medium text-brand-fg"
              >
                Choose servers
              </Link>
            )}
          </div>
        </div>
      ))}
      <ErrorBox error={release.error} />
    </div>
  );
}
