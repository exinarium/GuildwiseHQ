/** All time-dependent server code goes through `clock.now()` so tests can advance time (docs/ARCHITECTURE.md section 8.1). */
export interface Clock {
  now(): Date;
  /** Shifts the clock forward by `ms`. */
  advance(ms: number): void;
  setOffset(ms: number): void;
  readonly offsetMs: number;
}

export function createClock(): Clock {
  let offset = 0;
  return {
    now: () => new Date(Date.now() + offset),
    advance(ms) {
      offset += ms;
    },
    setOffset(ms) {
      offset = ms;
    },
    get offsetMs() {
      return offset;
    },
  };
}
