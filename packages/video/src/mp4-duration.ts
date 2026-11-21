import { open, stat } from 'node:fs/promises';

/**
 * The length of an MP4 in seconds, read in JavaScript: the app image has no ffmpeg, and the render job API must measure
 * an uploaded video itself (core DESIGN R16 [rv3-6]) rather than believe the worker. Throws when the file is not a plain
 * (non-fragmented) MP4 with a movie header.
 *
 * Bounded against hostile files (review S4): at most `MAX_TOP_LEVEL_BOXES` top-level boxes are walked, box sizes are
 * checked against the file's real size (from `stat`, never from a header), and `moov` is read only up to `MAX_MOOV`.
 * The length is the longest of the movie header (`mvhd`) and every track's media header (`mdhd`), so a movie header
 * that understates the length does not pass. Fragmented MP4s (`moof`, or `mvex` in `moov`) are refused: their length is
 * not in the headers. Residual: a file whose headers all understate its real media is not caught here; the publish
 * worker's Reels check before each Instagram post reads the streams with ffmpeg.
 */

export const MAX_TOP_LEVEL_BOXES = 1_000;
const MAX_MOOV = 64 * 1024 * 1024;
const MAX_CHILD_BOXES = 10_000;

interface Box {
  type: string;
  payload: Buffer;
}

/** The child boxes of a container payload (bounded; a malformed size stops the walk). */
function children(buf: Buffer): Box[] {
  const out: Box[] = [];
  let p = 0;
  while (p + 8 <= buf.length && out.length < MAX_CHILD_BOXES) {
    let size = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    let header = 8;
    if (size === 1) {
      if (p + 16 > buf.length) break;
      size = Number(buf.readBigUInt64BE(p + 8));
      header = 16;
    } else if (size === 0) size = buf.length - p;
    if (size < header || p + size > buf.length) break;
    out.push({ type, payload: buf.subarray(p + header, p + size) });
    p += size;
  }
  return out;
}

/** Seconds of a version-0/1 `mvhd` or `mdhd` payload (the same layout for timescale and duration). */
function headerSeconds(b: Buffer): number | null {
  if (b.length < 20) return null;
  const v1 = b[0] === 1;
  if (v1 && b.length < 32) return null;
  const timescale = v1 ? b.readUInt32BE(20) : b.readUInt32BE(12);
  const duration = v1 ? Number(b.readBigUInt64BE(24)) : b.readUInt32BE(16);
  if (!timescale) return null;
  return duration / timescale;
}

export async function mp4Duration(file: string): Promise<number> {
  const total = (await stat(file)).size;
  const fh = await open(file, 'r');
  try {
    const read = async (pos: number, len: number): Promise<Buffer> => {
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, pos);
      return buf.subarray(0, bytesRead);
    };
    let pos = 0;
    let moov: Buffer | null = null;
    for (let n = 0; pos + 8 <= total; n++) {
      if (n >= MAX_TOP_LEVEL_BOXES) throw new Error(`more than ${MAX_TOP_LEVEL_BOXES} top-level boxes`);
      const head = await read(pos, 16);
      if (head.length < 8) break;
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (size === 1) {
        if (head.length < 16) break;
        size = Number(head.readBigUInt64BE(8));
        header = 16;
      } else if (size === 0) size = total - pos;
      if (size < header || pos + size > total)
        throw new Error(`box ${JSON.stringify(type)} runs past the end of the file`);
      if (type === 'moof') throw new Error('a fragmented MP4 is not accepted');
      if (type === 'moov') {
        if (moov) throw new Error('more than one moov box');
        if (size - header > MAX_MOOV) throw new Error('the moov box is too large');
        moov = await read(pos + header, size - header);
      }
      pos += size;
    }
    if (!moov) throw new Error('not an MP4 file (no moov box)');
    const boxes = children(moov);
    if (boxes.some((b) => b.type === 'mvex')) throw new Error('a fragmented MP4 is not accepted');
    const mvhd = boxes.find((b) => b.type === 'mvhd');
    const movie = mvhd ? headerSeconds(mvhd.payload) : null;
    if (movie === null) throw new Error('the MP4 has no movie header');
    let longest = movie;
    for (const trak of boxes.filter((b) => b.type === 'trak')) {
      const mdia = children(trak.payload).find((b) => b.type === 'mdia');
      const mdhd = mdia && children(mdia.payload).find((b) => b.type === 'mdhd');
      const seconds = mdhd ? headerSeconds(mdhd.payload) : null;
      if (seconds !== null && seconds > longest) longest = seconds;
    }
    return longest;
  } finally {
    await fh.close();
  }
}
