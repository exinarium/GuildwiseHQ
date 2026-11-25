/**
 * tool-pin-lib (B3, S6): one `env.ensure` at a time in this process (every pairing shares the account's Guildwise tool
 * folder), the roots the running one found verified (`before`), and the count of approved runs outside the box that could
 * write the folder while it runs.
 */

let tail: Promise<void> = Promise.resolve();
let waiting = 0;
let running: { before: ReadonlySet<string>; startedAt: number } | null = null;
let outsideActive = 0;
let outsideEpoch = 0;

/** Runs `fn` after every earlier `env.ensure` of this process has ended (a promise mutex). `onWait`: told when it queues. */
export async function withEnsureLock<T>(fn: () => Promise<T>, onWait?: () => void): Promise<T> {
  const prev = tail;
  let release!: () => void;
  tail = new Promise<void>((r) => (release = r));
  if (running || waiting) onWait?.();
  waiting++;
  try {
    await prev;
  } finally {
    waiting--;
  }
  try {
    return await fn();
  } finally {
    running = null;
    release();
  }
}

/** Inside the lock: the roots this run found verified (new spawns see a changed one as off, with no Desk step). */
export function setRunning(before: Iterable<string>, now = Date.now()): void {
  running = { before: new Set(before), startedAt: now };
}

/** The roots of the run in flight, or null. */
export function runningBefore(): ReadonlySet<string> | null {
  return running?.before ?? null;
}

/** True while an `env.ensure` runs or waits. */
export function ensureBusy(): boolean {
  return running !== null || waiting > 0;
}

/**
 * Review S6 (the updater): waits until no `env.ensure` runs, at most `maxMs`, then keeps the lock (the process is about to
 * restart). Returns a release for when the restart does not happen. Resolves true when the lock was taken.
 */
export function holdForRestart(maxMs: number): Promise<{ held: boolean; release: () => void }> {
  return new Promise((resolve) => {
    let settled = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ held: false, release: () => {} });
    }, maxMs);
    timer.unref?.();
    void withEnsureLock(async () => {
      if (settled) return; // timed out: let the queue go on
      settled = true;
      clearTimeout(timer);
      resolve({ held: true, release });
      await gate;
    });
  });
}

/** An approved run outside the box started (`+1`) or ended (`-1`). */
export function noteOutside(delta: 1 | -1): void {
  if (delta === 1) {
    outsideActive++;
    outsideEpoch++;
  } else outsideActive = Math.max(0, outsideActive - 1);
}

/** The outside-run counter now: how many are active, and how many have started so far. */
export function outsideState(): { active: number; epoch: number } {
  return { active: outsideActive, epoch: outsideEpoch };
}

/** Test hook: forget everything. */
export function resetEnsureLockForTests(): void {
  tail = Promise.resolve();
  waiting = 0;
  running = null;
  outsideActive = 0;
  outsideEpoch = 0;
}
