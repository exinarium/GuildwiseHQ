import {
  DESIGN_GATE_REASON_TEXT,
  DESIGN_GATE_STAGE,
  type DesignGateReason,
  designGateDecision,
  designHighRiskPredicate,
  designRiskPaths,
  isOrgManager,
  type OrgRole,
  StoredRiskMapSchema,
  streamId,
  workflowHasDesignGate,
} from '@aom/shared';
import type { AuthSession } from '../auth/sessions.ts';
import { loadVisibleCard, loadVisibleProject } from '../authz/scope.ts';
import { loadWorkflowById, resolveWorkflow } from '../catalogue/loader.ts';
import type { Ctx } from '../context.ts';
import { one, type Row } from '../db/sql.ts';
import type { Tx } from '../db/tx.ts';
import { withAppendTx } from '../db/tx.ts';
import { conflict, forbidden } from '../errors.ts';
import { cardMessage, projectScope, userActor } from './common.ts';

type OrgRef = { id: string; role: OrgRole | null };

const NOT_SUPPORTED =
  "this project's workflow has no design gate: new cards must run on a workflow with Investigate & design and the design gate";

/** The project's Owner or an organization Owner/Admin may switch the design gate. */
function mayManage(myRole: unknown, org: OrgRef, orgId: string): boolean {
  return myRole === 'owner' || (isOrgManager({ orgRole: org.role }) && org.id === orgId);
}

/** Switches the project's design gate (default off). Refused when new cards of the project run without the gate stage. */
export async function setProjectDesignGate(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgRef,
  projectId: string,
  on: boolean,
): Promise<void> {
  await withAppendTx(ctx.pool, async (tx) => {
    const p = await loadVisibleProject(tx, user.id, projectId);
    if (!mayManage(p.my_role, org, p.org_id))
      throw forbidden('only the project Owner or an organization Owner or Admin can do this');
    if ((p.design_gate === true) === on) return;
    if (on) {
      const wf = await resolveWorkflow(tx, p.org_id, p.workflow_key, p.id);
      if (!wf || !workflowHasDesignGate(wf.definition))
        throw conflict('design_gate_not_supported', NOT_SUPPORTED);
    }
    await ctx.store.append(
      [
        {
          streamId: streamId.project(projectId),
          event: { type: 'ProjectDesignGateSet', payload: { projectId, on, by: user.id } },
          actor: userActor(user.id),
          scope: projectScope(p.org_id, projectId),
        },
      ],
      { tx },
    );
  });
}

/** Why the design gate cannot be switched on for this card (null: it can). Pure, for the refusal order of AC2. */
export function cardDesignGateRefusal(
  card: {
    ref?: unknown;
    stage?: unknown;
    status?: unknown;
    claim_id?: unknown;
    investigation?: unknown;
    investigation_only?: unknown;
  },
  hasGateStage: boolean,
): { code: string; message: string } | null {
  if (!hasGateStage)
    return {
      code: 'design_gate_not_supported',
      message: `${String(card.ref)} runs on a workflow without the design gate`,
    };
  const reportPath = (card.investigation as { reportPath?: string } | null)?.reportPath;
  if (!reportPath || card.investigation_only === true)
    return {
      code: 'no_design_report',
      message: `${String(card.ref)} has no design report yet. The design gate reviews the design report, so it can be switched on once the architect has handed one off.`,
    };
  const stage = String(card.stage);
  const early =
    stage.startsWith('investigate') ||
    stage === DESIGN_GATE_STAGE ||
    (stage === 'build' && card.status === 'queued' && !card.claim_id);
  if (!early)
    return {
      code: 'design_gate_too_late',
      message: `${String(card.ref)} is already being built: return it to design instead.`,
    };
  return null;
}

/**
 * The owner's switch for one card. On: only with a design report (AC2) and before Build has started; a card queued at
 * Build and unclaimed moves to the gate now, otherwise the switch applies at the next design hand-off. Off: no guard.
 */
export async function setCardDesignGate(
  ctx: Ctx,
  user: AuthSession['user'],
  org: OrgRef,
  idOrRef: string,
  on: boolean,
): Promise<{ moved: boolean }> {
  const result = await withAppendTx(ctx.pool, async (tx) => {
    const { card, role } = await loadVisibleCard(tx, user.id, idOrRef);
    if (!mayManage(role, org, card.org_id))
      throw forbidden('only the project Owner or an organization Owner or Admin can do this');
    const wf = await loadWorkflowById(tx, card.workflow_version_id);
    if (on) {
      const refusal = cardDesignGateRefusal(card, !!wf && workflowHasDesignGate(wf.definition));
      if (refusal) throw conflict(refusal.code, refusal.message);
    }
    const scope = projectScope(card.org_id, card.project_id);
    const actor = userActor(user.id);
    const moveNow = on && card.stage === 'build' && card.status === 'queued' && !card.claim_id;
    if ((card.design_gate_card === true) === on && !moveNow)
      return { cardId: card.id as string, moveNow: false };
    await ctx.store.append(
      [
        {
          streamId: streamId.card(card.id),
          event: { type: 'CardDesignGateSet', payload: { cardId: card.id, on, by: user.id } },
          actor,
          scope,
        },
        ...(moveNow
          ? [
              {
                streamId: streamId.card(card.id),
                event: {
                  type: 'DesignGateDecided' as const,
                  payload: { cardId: card.id, required: true, reason: 'card' as const, highRiskPaths: [] },
                },
                actor,
                scope,
              },
              // Not claimed yet: the card steps back from Build to the gate (the reactor opens the owner's desk item).
              {
                streamId: streamId.card(card.id),
                event: {
                  type: 'CardMovedByManager' as const,
                  payload: {
                    cardId: card.id,
                    fromStage: card.stage,
                    toStage: DESIGN_GATE_STAGE,
                    status: 'queued' as const,
                    reason: 'design gate switched on for this card',
                  },
                },
                actor,
                scope,
              },
              cardMessage(
                card,
                { kind: 'system' },
                'system',
                `${card.ref} waits at the design gate: the owner switched the design gate on for this card.`,
              ),
            ]
          : []),
      ],
      { tx },
    );
    return { cardId: card.id as string, moveNow };
  });
  return { moved: result.moveNow };
}

export interface DesignGateOutcome {
  required: boolean;
  reason: DesignGateReason;
  paths: string[];
}

/** The decision at the design hand-off: high-risk paths of the design, the card switch, the project setting. */
export async function decideDesignGate(
  tx: Tx,
  card: Row,
  designSummary: string | null | undefined,
): Promise<DesignGateOutcome> {
  const project = await one(tx, 'SELECT design_gate, risk_map FROM projects WHERE id=$1', [card.project_id]);
  const riskMap = StoredRiskMapSchema.safeParse(project?.risk_map).data ?? null;
  const planning = await one<{ note: string }>(
    tx,
    `SELECT note FROM card_handoffs WHERE card_id=$1 AND stage='planning' ORDER BY created_at DESC, event_seq DESC LIMIT 1`,
    [card.id],
  );
  const fields = (card.fields ?? {}) as Record<string, unknown>;
  const paths = designRiskPaths(
    {
      affectedAreas: typeof fields.affectedAreas === 'string' ? fields.affectedAreas : null,
      planningNote: planning?.note ?? null,
      designSummary: designSummary ?? null,
      cardBrief: (card.card_brief as string | null) ?? null,
    },
    designHighRiskPredicate(riskMap),
  );
  const gate = designGateDecision({
    projectGate: project?.design_gate === true,
    cardGate: card.design_gate_card === true,
    highRiskPaths: paths,
  });
  return { ...gate, paths };
}

/** The system thread note that records the decision and its reason. */
export function designGateMessage(card: Row, gate: DesignGateOutcome) {
  const text = DESIGN_GATE_REASON_TEXT[gate.reason];
  const paths = gate.reason === 'high_risk' ? ` (${gate.paths.slice(0, 10).join(', ')})` : '';
  return cardMessage(
    card,
    { kind: 'system' },
    'system',
    gate.required
      ? `Design gate required for ${card.ref}: ${text}${paths}.`
      : `Design gate not required for ${card.ref}: ${text}.`,
  );
}
