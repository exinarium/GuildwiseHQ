import { readFileSync, writeFileSync } from 'node:fs';

interface Pcm {
  rate: number;
  channels: number;
  bits: number;
  data: Buffer;
}

function readPcm(file: string): Pcm {
  const b = readFileSync(file);
  let p = 12;
  let fmt: { rate: number; channels: number; bits: number } | undefined;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ')
      fmt = { channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data' && fmt)
      return { ...fmt, data: b.subarray(p + 8, p + 8 + Math.min(size, b.length - p - 8)) };
    p += 8 + size + (size % 2);
  }
  throw new Error(`no audio data in ${file}`);
}

function wavHeader(pcm: Omit<Pcm, 'data'>, bytes: number): Buffer {
  const h = Buffer.alloc(44);
  const blockAlign = (pcm.channels * pcm.bits) / 8;
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(pcm.channels, 22);
  h.writeUInt32LE(pcm.rate, 24);
  h.writeUInt32LE(pcm.rate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(pcm.bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(bytes, 40);
  return h;
}

/** One 16-bit PCM WAV of silence. */
export function writeSilentWav(file: string, seconds: number, rate = 24000): void {
  const bytes = Math.round(seconds * rate) * 2;
  writeFileSync(
    file,
    Buffer.concat([wavHeader({ rate, channels: 1, bits: 16 }, bytes), Buffer.alloc(bytes)]),
  );
}

/**
 * The cue recordings one after the other, each followed by `gapSeconds` of silence, in one WAV. All recordings must
 * share a format (Kokoro writes 24 kHz mono). Starting a cue at the sum of the earlier slots is what the timeline
 * assumes.
 */
export function joinWavs(files: string[], gapSeconds: number, dest: string): void {
  const parts = files.map(readPcm);
  const first = parts[0];
  if (!first) throw new Error('nothing to join');
  const chunks: Buffer[] = [];
  for (const p of parts) {
    if (p.rate !== first.rate || p.channels !== first.channels || p.bits !== first.bits)
      throw new Error('recordings differ in format');
    const frame = (p.channels * p.bits) / 8;
    chunks.push(p.data, Buffer.alloc(Math.round(gapSeconds * p.rate) * frame));
  }
  const data = Buffer.concat(chunks);
  writeFileSync(dest, Buffer.concat([wavHeader(first, data.length), data]));
}
