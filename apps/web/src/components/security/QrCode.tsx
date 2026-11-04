import { useMemo } from 'react';
import { QR_QUIET, qrMatrix, qrPathData } from '../../lib/qr.ts';

/** A QR code drawn as an inline SVG (no network, no images): used for the authenticator app's `otpauth://` URI. */
export function QrCode({ value, label, size = 176 }: { value: string; label: string; size?: number }) {
  const { modules, count } = useMemo(() => qrMatrix(value), [value]);
  const box = count + QR_QUIET * 2;
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
      <path fill="#0D1220" d={qrPathData(modules)} />
    </svg>
  );
}
