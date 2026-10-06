import { CROP_OUT, type CropState, cropSource } from './crop.ts';

/** Pictures larger than this (longest side) are scaled down before cropping, so a phone photo stays light. */
const WORK_SIDE = 1280;
/** Refuse a file bigger than this before even trying to decode it. */
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

export class ImageError extends Error {}

/** A `data:` URL for the file (the CSP allows `data:` images, not `blob:`). */
function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new ImageError('That file could not be read.'));
    r.readAsDataURL(file);
  });
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new ImageError('That image could not be opened. Try a JPEG or PNG.'));
    img.src = src;
  });
}

/** Reads a chosen or captured file into a picture ready to crop (scaled down when it is large). */
export async function prepareImageFile(file: File): Promise<HTMLImageElement> {
  if (!file.type.startsWith('image/')) throw new ImageError('Choose an image file.');
  if (file.size > MAX_FILE_BYTES) throw new ImageError('That image is too large (20 MB at most).');
  const img = await loadImage(await readAsDataUrl(file));
  const side = Math.max(img.naturalWidth, img.naturalHeight);
  if (side <= WORK_SIDE) return img;
  const k = WORK_SIDE / side;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * k);
  canvas.height = Math.round(img.naturalHeight * k);
  const ctx = canvas.getContext('2d');
  if (!ctx) return img;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return loadImage(canvas.toDataURL('image/png'));
}

/** The cropped circle as a 256 px square PNG with transparent corners, base64 (no `data:` prefix). */
export function renderCrop(img: HTMLImageElement, s: CropState): string {
  const canvas = document.createElement('canvas');
  canvas.width = CROP_OUT;
  canvas.height = CROP_OUT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new ImageError('This browser cannot crop pictures.');
  const { sx, sy, size } = cropSource(s);
  ctx.beginPath();
  ctx.arc(CROP_OUT / 2, CROP_OUT / 2, CROP_OUT / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(img, sx, sy, size, size, 0, 0, CROP_OUT, CROP_OUT);
  const url = canvas.toDataURL('image/png');
  return url.slice(url.indexOf(',') + 1);
}
