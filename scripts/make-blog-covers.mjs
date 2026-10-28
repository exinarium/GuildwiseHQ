// Writes the branded default blog covers (1200x630 PNG, one per tag) to apps/web/public/blog/cover/.
// Facebook and LinkedIn cannot use SVG previews, so these are real PNGs. No dependencies: the PNG is encoded by hand.
// Run: node scripts/make-blog-covers.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 1200;
const H = 630;
const BASE = [13, 18, 32]; // #0d1220, the product's dark side colour
const ACCENT = [212, 242, 74]; // #d4f24a
const TAGS = {
  'ai-agents': [52, 70, 217],
  automation: [23, 114, 74],
  'llm-ops': [124, 58, 237],
  'case-study': [194, 65, 12],
  'how-to': [10, 100, 180],
  'industry-news': [190, 24, 93],
  // Release announcements (/releases): one static cover, no version text.
  release: [14, 116, 144],
};

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

function cover(hue) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W * 3 + 1)] = 0;
    for (let x = 0; x < W; x++) {
      // diagonal gradient from the dark base to the tag colour
      let px = mix(BASE, hue, Math.min(1, Math.max(0, (x / W) * 0.7 + (y / H) * 0.3)) ** 1.6);
      // a ring of "hands": concentric arcs on the right
      const d = Math.hypot(x - 930, y - 315);
      if (Math.abs((((d % 70) + 70) % 70) - 35) < 3 && d < 300) px = mix(px, ACCENT, 0.55);
      // accent bar along the bottom
      if (y > H - 14) px = ACCENT;
      const o = y * (W * 3 + 1) + 1 + x * 3;
      raw[o] = px[0];
      raw[o + 1] = px[1];
      raw[o + 2] = px[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../apps/web/public/blog/cover/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [key, hue] of Object.entries(TAGS)) writeFileSync(new URL(`${key}.png`, dir), cover(hue));
console.log(`wrote ${Object.keys(TAGS).length} covers`);
