import { z } from 'zod';
import { DESIGN_GATE_MAX_PATHS } from '../workflows/design-gate.ts';
import { defineEvent, Id } from './define.ts';

/** The design gate (`code` version 7): the project setting, the card switch and the decision at the design hand-off. */
export const DesignGateReasonSchema = z.enum(['high_risk', 'card', 'project', 'off']);

export const designGateEvents = [
  /** The owner switched the project's design gate on or off (default: off). */
  defineEvent('ProjectDesignGateSet', z.object({ projectId: Id, on: z.boolean(), by: Id })),
  /** The owner switched the design gate on or off for one card (on only once the card has a design report). */
  defineEvent('CardDesignGateSet', z.object({ cardId: Id, on: z.boolean(), by: Id })),
  /** The server decided at the design hand-off whether the card stops at the design gate, and why. */
  defineEvent(
    'DesignGateDecided',
    z.object({
      cardId: Id,
      required: z.boolean(),
      reason: DesignGateReasonSchema,
      highRiskPaths: z.array(z.string().max(500)).max(DESIGN_GATE_MAX_PATHS).default([]),
    }),
  ),
] as const;
