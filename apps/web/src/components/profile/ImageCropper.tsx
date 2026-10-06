import { type KeyboardEvent, type PointerEvent, useRef, useState } from 'react';
import { renderCrop } from '../../lib/avatarImage.ts';
import { CROP_MAX_ZOOM, CROP_VIEW, type CropState, clampCrop, cropScale } from '../../lib/crop.ts';
import { Button, ErrorBox } from '../ui.tsx';

const STEP = 12;

/**
 * The circular crop step for a photographed or uploaded picture: drag to move, the slider (or + and -) to zoom,
 * arrow keys to nudge. The result is a 256 px PNG with transparent corners.
 */
export function ImageCropper({
  image,
  onCancel,
  onDone,
  busy = false,
  confirmLabel = 'Use this picture',
}: {
  image: HTMLImageElement;
  onCancel: () => void;
  onDone: (pngBase64: string) => void;
  busy?: boolean;
  confirmLabel?: string;
}) {
  const natW = image.naturalWidth;
  const natH = image.naturalHeight;
  const [s, setS] = useState<CropState>({ natW, natH, zoom: 1, offsetX: 0, offsetY: 0 });
  const [error, setError] = useState<Error | null>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const scale = cropScale(s);
  const move = (dx: number, dy: number) =>
    setS((c) => clampCrop({ ...c, offsetX: c.offsetX + dx, offsetY: c.offsetY + dy }));
  const zoomTo = (z: number) => setS((c) => clampCrop({ ...c, zoom: z }));

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: s.offsetX, oy: s.offsetY };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d) setS((c) => clampCrop({ ...c, offsetX: d.ox + e.clientX - d.x, offsetY: d.oy + e.clientY - d.y }));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const k = e.key;
    if (k === 'ArrowLeft') move(STEP, 0);
    else if (k === 'ArrowRight') move(-STEP, 0);
    else if (k === 'ArrowUp') move(0, STEP);
    else if (k === 'ArrowDown') move(0, -STEP);
    else if (k === '+' || k === '=') zoomTo(s.zoom + 0.2);
    else if (k === '-') zoomTo(s.zoom - 0.2);
    else return;
    e.preventDefault();
  };

  return (
    <div className="flex flex-col items-center gap-4" data-testid="avatar-cropper">
      {/* biome-ignore lint/a11y/useSemanticElements: a custom pan surface; the slider below is the accessible control */}
      <div
        role="group"
        aria-label="Move the picture inside the circle. Arrow keys move it, plus and minus zoom."
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard panning of the crop surface
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={onKey}
        style={{ width: CROP_VIEW, height: CROP_VIEW, touchAction: 'none' }}
        className="relative cursor-grab overflow-hidden rounded-card bg-sunken select-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:cursor-grabbing"
      >
        <img
          src={image.src}
          alt=""
          draggable={false}
          data-testid="crop-image"
          style={{
            position: 'absolute',
            width: natW * scale,
            height: natH * scale,
            maxWidth: 'none',
            left: (CROP_VIEW - natW * scale) / 2 + s.offsetX,
            top: (CROP_VIEW - natH * scale) / 2 + s.offsetY,
          }}
        />
        {/* the circle: everything outside it is dimmed, the ring marks the edge */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full ring-2 ring-white/90"
          style={{ boxShadow: '0 0 0 999px rgb(13 18 32 / 0.55)' }}
        />
      </div>
      <label className="flex w-full max-w-[16rem] items-center gap-3 text-sm text-muted">
        Zoom
        <input
          type="range"
          min={1}
          max={CROP_MAX_ZOOM}
          step={0.05}
          value={s.zoom}
          aria-label="Zoom"
          onChange={(e) => zoomTo(Number(e.target.value))}
          className="min-w-0 flex-1 accent-brand"
        />
      </label>
      <ErrorBox error={error} />
      <div className="flex w-full justify-end gap-2">
        <Button onClick={onCancel} disabled={busy}>
          Back
        </Button>
        <Button
          variant="primary"
          loading={busy}
          data-testid="crop-confirm"
          onClick={() => {
            try {
              onDone(renderCrop(image, s));
            } catch (e) {
              setError(e instanceof Error ? e : new Error('Could not crop the picture.'));
            }
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  );
}
