import qrcode from 'qrcode-generator';

/** Blank border around the code, in modules. */
export const QR_QUIET = 2;

/** The dark modules of the QR code for `value` (error correction M), with the module count per side. */
export function qrMatrix(value: string): { count: number; modules: Array<[number, number]> } {
  const qr = qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  const n = qr.getModuleCount();
  const modules: Array<[number, number]> = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) modules.push([r, c]);
  return { count: n, modules };
}

/** The `d` of the dark modules, shared by the on-screen component and the SVG download. */
export const qrPathData = (modules: ReadonlyArray<[number, number]>, quiet = QR_QUIET): string =>
  modules.map(([r, c]) => `M${c + quiet} ${r + quiet}h1v1h-1z`).join('');

/** A standalone SVG document of the code (white background, quiet zone). */
export function qrSvg(value: string, size = 512): string {
  const { count, modules } = qrMatrix(value);
  const box = count + QR_QUIET * 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges">` +
    `<rect width="${box}" height="${box}" fill="#fff"/><path fill="#000" d="${qrPathData(modules)}"/></svg>`
  );
}

/** A PNG of the code: `scale` pixels per module. */
export function qrPng(value: string, scale = 10): Promise<Blob> {
  const { count, modules } = qrMatrix(value);
  const box = count + QR_QUIET * 2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = box * scale;
  const g = canvas.getContext('2d');
  if (!g) return Promise.reject(new Error('canvas not available'));
  g.fillStyle = '#fff';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.fillStyle = '#000';
  for (const [r, c] of modules) g.fillRect((c + QR_QUIET) * scale, (r + QR_QUIET) * scale, scale, scale);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('png failed'))), 'image/png'),
  );
}
