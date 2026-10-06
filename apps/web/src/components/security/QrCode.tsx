import qrcode from 'qrcode-generator';
import { useMemo } from 'react';

/** A QR code drawn as an inline SVG (no network, no images): used for the authenticator app's `otpauth://` URI. */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const { modules, count } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const dark: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([r, c]);
    return { modules: dark, count: n };
  }, [value]);
  const quiet = 2;
  const box = count + quiet * 2;
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${box} ${box}`}
      shapeRendering="crispEdges"
      className="rounded-control border border-line bg-white"
    >
      <rect width={box} height={box} fill="#fff" />
      <path fill="#0D1220" d={modules.map(([r, c]) => `M${c + quiet} ${r + quiet}h1v1h-1z`).join('')} />
    </svg>
  );
}
