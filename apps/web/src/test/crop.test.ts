import { describe, expect, it } from 'vitest';
import { CROP_VIEW, clampCrop, cropScale, cropSource } from '../lib/crop.ts';

const base = { zoom: 1, offsetX: 0, offsetY: 0 };

describe('crop geometry', () => {
  it('at zoom 1 a landscape picture covers the viewport by its short side, centred', () => {
    const s = { ...base, natW: 800, natH: 400 };
    expect(cropScale(s)).toBeCloseTo(CROP_VIEW / 400);
    const src = cropSource(s);
    expect(src.size).toBeCloseTo(400);
    expect(src.sx).toBeCloseTo(200);
    expect(src.sy).toBeCloseTo(0);
  });

  it('zooming in shows a smaller part of the picture', () => {
    const s = { ...base, natW: 400, natH: 400, zoom: 2 };
    expect(cropSource(s).size).toBeCloseTo(200);
    expect(cropSource(s).sx).toBeCloseTo(100);
  });

  it('panning moves the window the opposite way and can never expose an empty edge', () => {
    const s = { natW: 400, natH: 400, zoom: 2, offsetX: 10_000, offsetY: -10_000 };
    const c = clampCrop(s);
    expect(c.offsetX).toBeCloseTo(CROP_VIEW / 2); // (512 - 256) / 2
    expect(c.offsetY).toBeCloseTo(-CROP_VIEW / 2);
    const src = cropSource(s);
    expect(src.sx).toBeCloseTo(0);
    expect(src.sy).toBeCloseTo(200);
    expect(src.sx + src.size).toBeLessThanOrEqual(400.0001);
    expect(src.sy + src.size).toBeLessThanOrEqual(400.0001);
  });

  it('keeps the zoom between 1 and the maximum', () => {
    expect(clampCrop({ natW: 100, natH: 100, zoom: 0.2, offsetX: 0, offsetY: 0 }).zoom).toBe(1);
    expect(clampCrop({ natW: 100, natH: 100, zoom: 99, offsetX: 0, offsetY: 0 }).zoom).toBe(4);
  });
});
