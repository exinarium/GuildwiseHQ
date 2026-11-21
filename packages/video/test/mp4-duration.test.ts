import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findFfmpeg, mp4Duration, RENDER_ENCODERS, runFfmpeg } from '../src/index.ts';

/** The server measures an uploaded video itself (R16), in JavaScript, because the app image has no ffmpeg. */

const dir = mkdtempSync(join(tmpdir(), 'mp4-duration-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function box(type: string, payload: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

const hasFfmpeg = (() => {
  try {
    findFfmpeg(RENDER_ENCODERS);
    return true;
  } catch {
    return false;
  }
})();

describe('mp4Duration', () => {
  it('reads a version-0 and a version-1 movie header', async () => {
    const v0 = Buffer.alloc(100);
    v0.writeUInt32BE(600, 12);
    v0.writeUInt32BE(600 * 42, 16);
    const a = join(dir, 'v0.mp4');
    writeFileSync(a, Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0')), box('moov', box('mvhd', v0))]));
    expect(await mp4Duration(a)).toBe(42);
    const v1 = Buffer.alloc(112);
    v1[0] = 1;
    v1.writeUInt32BE(90_000, 20);
    v1.writeBigUInt64BE(BigInt(90_000 * 7.5), 24);
    const b = join(dir, 'v1.mp4');
    writeFileSync(
      b,
      Buffer.concat([
        box('ftyp', Buffer.from('isom\0\0\0\0')),
        box('mdat', Buffer.alloc(16)),
        box('moov', box('mvhd', v1)),
      ]),
    );
    expect(await mp4Duration(b)).toBe(7.5);
  });

  it('throws for a file that is not an MP4, or one without a movie header', async () => {
    const junk = join(dir, 'junk.mp4');
    writeFileSync(junk, 'this is not a video');
    await expect(mp4Duration(junk)).rejects.toThrow();
    const nomvhd = join(dir, 'nomvhd.mp4');
    writeFileSync(
      nomvhd,
      Buffer.concat([box('ftyp', Buffer.from('isom\0\0\0\0')), box('moov', box('trak', Buffer.alloc(8)))]),
    );
    await expect(mp4Duration(nomvhd)).rejects.toThrow(/no movie header/);
  });

  const mvhd = (seconds: number) => {
    const b = Buffer.alloc(100);
    b.writeUInt32BE(1000, 12);
    b.writeUInt32BE(Math.round(seconds * 1000), 16);
    return box('mvhd', b);
  };
  const mdhdTrak = (seconds: number) => {
    const b = Buffer.alloc(24);
    b.writeUInt32BE(90_000, 12);
    b.writeUInt32BE(Math.round(seconds * 90_000), 16);
    return box('trak', box('mdia', box('mdhd', b)));
  };
  const ftyp = box('ftyp', Buffer.from('isom\0\0\0\0'));

  it('takes the longest of the movie header and every track header (a lying mvhd does not pass)', async () => {
    const f = join(dir, 'lying.mp4');
    writeFileSync(
      f,
      Buffer.concat([ftyp, box('moov', Buffer.concat([mvhd(10), mdhdTrak(7200), mdhdTrak(9)]))]),
    );
    expect(await mp4Duration(f)).toBe(7200);
  });

  it('refuses fragmented MP4s (moof at the top, or mvex in moov)', async () => {
    const a = join(dir, 'moof.mp4');
    writeFileSync(
      a,
      Buffer.concat([ftyp, box('moov', mvhd(5)), box('moof', Buffer.alloc(8)), box('mdat', Buffer.alloc(8))]),
    );
    await expect(mp4Duration(a)).rejects.toThrow(/fragmented/);
    const b = join(dir, 'mvex.mp4');
    writeFileSync(
      b,
      Buffer.concat([ftyp, box('moov', Buffer.concat([mvhd(0), box('mvex', Buffer.alloc(8))]))]),
    );
    await expect(mp4Duration(b)).rejects.toThrow(/fragmented/);
  });

  it('stops after a bounded number of top-level boxes, and refuses a box larger than the file', async () => {
    const many = join(dir, 'many.mp4');
    writeFileSync(
      many,
      Buffer.concat([ftyp, ...Array.from({ length: 1_200 }, () => box('free', Buffer.alloc(0)))]),
    );
    await expect(mp4Duration(many)).rejects.toThrow(/more than 1000 top-level boxes/);
    const big = join(dir, 'big.mp4');
    const moov = box('moov', mvhd(5));
    moov.writeUInt32BE(moov.length + 10_000_000, 0); // the header claims more than the file holds
    writeFileSync(big, Buffer.concat([ftyp, moov]));
    await expect(mp4Duration(big)).rejects.toThrow(/runs past the end of the file/);
  });

  it.skipIf(!hasFfmpeg)('matches the length ffmpeg wrote', async () => {
    const out = join(dir, 'real.mp4');
    runFfmpeg([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30:duration=4',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      out,
    ]);
    expect(await mp4Duration(out)).toBeCloseTo(4, 1);
  });
});
