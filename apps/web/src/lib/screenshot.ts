/**
 * Captures what the person is looking at, for a Contact us request. html2canvas-pro (bundled and loaded only when
 * asked: no external script, so the CSP stays shut) draws the page into a canvas; anything marked
 * `data-no-capture` (the dialogs themselves) is left out. Returns a data URL under 2.5 MB, or null when the browser
 * cannot do it: the form then offers an upload instead.
 */
const MAX_BYTES = 2.5 * 1024 * 1024;
const MAX_WIDTH = 1600;

const bytesOf = (dataUrl: string): number =>
  Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

export async function captureView(): Promise<string | null> {
  try {
    const { default: html2canvas } = await import('html2canvas-pro');
    const canvas = await html2canvas(document.body, {
      scale: Math.min(window.devicePixelRatio || 1, 1.5),
      logging: false,
      useCORS: false,
      backgroundColor: getComputedStyle(document.body).backgroundColor || '#ffffff',
      x: window.scrollX,
      y: window.scrollY,
      width: window.innerWidth,
      height: window.innerHeight,
      ignoreElements: (el) =>
        el instanceof HTMLElement &&
        (el.hasAttribute('data-no-capture') ||
          el.hasAttribute('data-radix-portal') ||
          el.getAttribute('role') === 'dialog'),
    });
    return downscale(canvas);
  } catch {
    return null;
  }
}

function downscale(canvas: HTMLCanvasElement): string | null {
  let out = canvas;
  if (canvas.width > MAX_WIDTH) {
    const c = document.createElement('canvas');
    c.width = MAX_WIDTH;
    c.height = Math.round((canvas.height * MAX_WIDTH) / canvas.width);
    c.getContext('2d')?.drawImage(canvas, 0, 0, c.width, c.height);
    out = c;
  }
  const png = out.toDataURL('image/png');
  if (bytesOf(png) <= MAX_BYTES) return png;
  const jpeg = out.toDataURL('image/jpeg', 0.8);
  return bytesOf(jpeg) <= MAX_BYTES ? jpeg : null;
}

/** An image file chosen by the person: PNG, JPEG or WebP, at most 2.5 MB, as a data URL. */
export function readImageFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp)$/.test(file.type))
      return reject(new Error('Choose a PNG, JPEG or WebP image.'));
    if (file.size > MAX_BYTES) return reject(new Error('That image is larger than 2.5 MB.'));
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The image could not be read.'));
    r.readAsDataURL(file);
  });
}
