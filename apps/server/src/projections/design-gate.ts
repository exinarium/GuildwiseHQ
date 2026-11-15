import type { EventOf, EventType } from '@aom/shared';
import { exec } from '../db/sql.ts';
import type { Projector, StoredEvent } from '../eventstore/types.ts';

const ev = <T extends EventType>(e: StoredEvent): EventOf<T> => e.event as EventOf<T>;

/** The design gate (code version 7): the project setting, the card switch and the decision at the design hand-off. */
export const designGateProjectors: Record<string, Projector> = {
  ProjectDesignGateSet: async (tx, e) => {
    const p = ev<'ProjectDesignGateSet'>(e).payload;
    await exec(tx, 'UPDATE projects SET design_gate=$2 WHERE id=$1', [p.projectId, p.on]);
  },

  CardDesignGateSet: async (tx, e) => {
    const p = ev<'CardDesignGateSet'>(e).payload;
    await exec(tx, 'UPDATE cards SET design_gate_card=$2, updated_at=$3 WHERE id=$1', [
      p.cardId,
      p.on,
      e.createdAt,
    ]);
  },

  DesignGateDecided: async (tx, e) => {
    const p = ev<'DesignGateDecided'>(e).payload;
    await exec(
      tx,
      'UPDATE cards SET design_gate_required=$2, design_gate_reason=$3, design_gate_paths=$4, updated_at=$5 WHERE id=$1',
      [p.cardId, p.required, p.reason, p.highRiskPaths, e.createdAt],
    );
  },
};
