import { createHash } from 'node:crypto';
import { AVATAR_STYLES } from '@aom/shared';
import { describe, expect, it } from 'vitest';
import { faceUri, loadFaceStyle } from '../lib/faces.ts';
import fixture from './fixtures/faces-v9.json';

/**
 * Stored avatar seeds must keep drawing the same face. The reference hashes were captured on DiceBear 9.x
 * (core 9.4.3, styles 9.4.2). A change here alters every stored face and needs an owner decision first; see
 * docs/investigations/GWP-191-dicebear-v10-upgrade.md. Do not re-capture the fixture to make this pass.
 */
const svgOf = (uri: string) => decodeURIComponent(uri.slice(uri.indexOf(',') + 1));
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('generated faces stay the same for stored seeds', () => {
  for (const style of AVATAR_STYLES) {
    it(`${style} matches the 9.x reference`, async () => {
      const refs = fixture.filter((f) => f.style === style);
      expect(refs.length, `the ${style} reference needs at least 5 seeds`).toBeGreaterThanOrEqual(5);
      await loadFaceStyle(style);
      for (const ref of refs) {
        const uri = faceUri(ref.seed, style) ?? '';
        expect(uri.startsWith('data:image/svg+xml;'), `${style} "${ref.seed}" is not an SVG data URI`).toBe(
          true,
        );
        const svg = svgOf(uri);
        expect(svg.startsWith('<svg'), `${style} "${ref.seed}" is not an SVG`).toBe(true);
        expect(
          { sha256: sha256(svg), length: svg.length },
          `${style} face for seed "${ref.seed}" changed: this alters stored faces and needs an owner decision (docs/investigations/GWP-191-dicebear-v10-upgrade.md)`,
        ).toEqual({ sha256: ref.sha256, length: ref.length });
      }
    });
  }
});
