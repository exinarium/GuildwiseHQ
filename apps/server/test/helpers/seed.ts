import { type DomainEvent, DomainEventSchema } from '@aom/shared';
import type { AppendInput } from '../../src/eventstore/types.ts';
import type { World } from './world.ts';

type RawInput = Omit<AppendInput, 'event'> & { event: { type: string; payload: Record<string, unknown> } };

/** Appends events written by hand in tests: payload defaults are applied by parsing with the domain schema. */
export function seed(w: World, inputs: RawInput[]) {
  return w.t.app.ctx.store.append(
    inputs.map((i) => ({ ...i, event: DomainEventSchema.parse(i.event) as DomainEvent })),
  );
}
