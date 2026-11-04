import { describe, expect, it } from 'vitest';
import { QR_QUIET, qrMatrix, qrPathData, qrSvg } from '../lib/qr.ts';

const URL_SHORT = 'https://hq.example.com/f/AbCdEfGhIjKlMnOpQrStUv';
const URL_LONG = `${URL_SHORT}#c=v1.${'a'.repeat(22)}.1abcde.${'b'.repeat(43)}`;

describe('qr', () => {
  it('makes the same code for the same text and a different code for other text', () => {
    expect(qrMatrix(URL_SHORT)).toEqual(qrMatrix(URL_SHORT));
    expect(qrMatrix(URL_SHORT)).not.toEqual(qrMatrix(`${URL_SHORT}x`));
  });

  it('a long address with a personal-link token still fits and gets a bigger code', () => {
    const a = qrMatrix(URL_SHORT);
    const b = qrMatrix(URL_LONG);
    expect(b.count).toBeGreaterThan(a.count);
    // finder pattern: the three corners of a QR code are dark at module (0,0), (0,n-7) and (n-7,0)
    for (const m of [a, b]) {
      const dark = new Set(m.modules.map(([r, c]) => `${r},${c}`));
      expect(dark.has('0,0') && dark.has(`0,${m.count - 7}`) && dark.has(`${m.count - 7},0`)).toBe(true);
    }
  });

  it('the SVG download is the same drawing as the on-screen one, with a quiet zone', () => {
    const { count, modules } = qrMatrix(URL_LONG);
    const svg = qrSvg(URL_LONG);
    expect(svg).toContain(`viewBox="0 0 ${count + QR_QUIET * 2} ${count + QR_QUIET * 2}"`);
    expect(svg).toContain(`d="${qrPathData(modules)}"`);
    expect(svg).not.toMatch(/<script|href=|onload/i);
  });
});
