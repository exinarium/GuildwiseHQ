import { closeSync, copyFileSync, existsSync, openSync, readSync, statSync, truncateSync } from 'node:fs';

/** Rotate a service log at this size, keeping one older file (`<log>.1`). */
export const LOG_ROTATE_BYTES = 20 * 1024 * 1024;

/** Last `n` lines of a file, reading at most `maxBytes` from its end. Missing file: no lines. */
export function tailLines(path: string, n: number, maxBytes = 512 * 1024): string[] {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return [];
  }
  const len = Math.min(size, maxBytes);
  if (len === 0) return [];
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (size > len) lines.shift(); // the first line is probably cut
    return lines.slice(-n);
  } finally {
    closeSync(fd);
  }
}

/** Copy-truncate rotation: the service keeps its (append-mode) descriptor, so it needs no signal. */
export function rotateIfBig(path: string, maxBytes = LOG_ROTATE_BYTES): boolean {
  try {
    if (!existsSync(path) || statSync(path).size < maxBytes) return false;
    copyFileSync(path, `${path}.1`);
    truncateSync(path, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads what was appended to a file since the last call (by offset); handles truncation by rotation. */
export class FileFollower {
  private offset: number;
  private partial = '';

  /** `fromEnd`: start at the end of the file (only new output). */
  constructor(
    private readonly path: string,
    fromEnd: boolean,
  ) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      // not there yet
    }
    this.offset = fromEnd ? size : 0;
  }

  read(maxBytes = 256 * 1024): string[] {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return [];
    }
    if (size < this.offset) {
      this.offset = 0; // rotated
      this.partial = '';
    }
    if (size === this.offset) return [];
    const len = Math.min(size - this.offset, maxBytes);
    const fd = openSync(this.path, 'r');
    try {
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, this.offset);
      this.offset += len;
      const text = this.partial + buf.toString('utf8');
      const lines = text.split('\n');
      this.partial = lines.pop() ?? '';
      return lines;
    } finally {
      closeSync(fd);
    }
  }
}
