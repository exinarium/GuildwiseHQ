import { createServer } from 'node:net';
import { RESERVED_RUN_PORTS } from '@aom/shared';

/** Can this machine listen on the port right now (loopback and all interfaces)? */
export async function isPortFree(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '0.0.0.0']) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = createServer();
      s.once('error', () => resolve(false));
      s.listen({ port, host, exclusive: true }, () => s.close(() => resolve(true)));
    });
    if (!ok) return false;
  }
  return true;
}

export interface PortRange {
  from: number;
  to: number;
}

/**
 * Ports of environments (design D5): the default is used when it is free and nobody else on this runner holds it;
 * otherwise one is allocated from the range. `held` is what the other environments of this runner already use.
 */
export class PortAllocator {
  private cursor: number;

  constructor(
    private readonly range: PortRange,
    private readonly free: (port: number) => Promise<boolean> = isPortFree,
  ) {
    this.cursor = range.from + Math.floor(Math.random() * Math.max(1, range.to - range.from));
  }

  /** The default when usable, else a free port from the range; null when the range is exhausted. */
  async pick(
    wanted: number,
    held: ReadonlySet<number>,
    canMove: boolean,
  ): Promise<{ port: number; moved: boolean } | null> {
    const usable = (p: number) => !held.has(p) && !RESERVED_RUN_PORTS.includes(p);
    if (usable(wanted) && (await this.free(wanted))) return { port: wanted, moved: false };
    if (!canMove) return null;
    const size = this.range.to - this.range.from + 1;
    for (let i = 0; i < size; i++) {
      const p = this.range.from + ((this.cursor - this.range.from + i) % size);
      if (usable(p) && (await this.free(p))) {
        this.cursor = p + 1;
        return { port: p, moved: true };
      }
    }
    return null;
  }
}
