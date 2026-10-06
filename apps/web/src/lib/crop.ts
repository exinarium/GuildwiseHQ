/** The picture the user crops is shown in a square viewport; the result is a circle, 256 px across. */
export const CROP_VIEW = 256;
export const CROP_OUT = 256;
export const CROP_MAX_ZOOM = 4;

export interface CropState {
  /** Natural size of the picture. */
  natW: number;
  natH: number;
  /** 1 = the picture just covers the viewport; larger zooms in. */
  zoom: number;
  /** Pan, in viewport pixels, from the centred position. */
  offsetX: number;
  offsetY: number;
}

/** Display scale (viewport pixels per picture pixel) at a zoom. */
export const cropScale = (s: Pick<CropState, 'natW' | 'natH' | 'zoom'>, view = CROP_VIEW): number =>
  Math.max(view / s.natW, view / s.natH) * s.zoom;

/** Keeps the picture covering the viewport: the pan can never expose an empty edge. */
export function clampCrop(s: CropState, view = CROP_VIEW): CropState {
  const scale = cropScale(s, view);
  const maxX = Math.max(0, (s.natW * scale - view) / 2);
  const maxY = Math.max(0, (s.natH * scale - view) / 2);
  return {
    ...s,
    zoom: Math.min(CROP_MAX_ZOOM, Math.max(1, s.zoom)),
    offsetX: Math.min(maxX, Math.max(-maxX, s.offsetX)),
    offsetY: Math.min(maxY, Math.max(-maxY, s.offsetY)),
  };
}

/** The part of the picture (in its own pixels) that the viewport shows: what the output is drawn from. */
export function cropSource(s: CropState, view = CROP_VIEW): { sx: number; sy: number; size: number } {
  const c = clampCrop(s, view);
  const scale = cropScale(c, view);
  const left = (view - c.natW * scale) / 2 + c.offsetX;
  const top = (view - c.natH * scale) / 2 + c.offsetY;
  return { sx: -left / scale, sy: -top / scale, size: view / scale };
}
