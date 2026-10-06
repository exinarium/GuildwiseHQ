import { Camera, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { loadImage } from '../../lib/avatarImage.ts';
import { Button, ErrorBox } from '../ui.tsx';

const noCamera = () => typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia;

/**
 * Take a photo with the camera (getUserMedia). Where there is no camera API, or the camera is blocked, a plain file
 * input with `capture` opens the phone's own camera app instead. The frame is handed on as a picture to crop.
 */
export function CameraCapture({
  onPhoto,
  onFile,
}: {
  onPhoto: (img: HTMLImageElement) => void;
  onFile: (file: File) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<'idle' | 'starting' | 'live' | 'unavailable'>(
    noCamera() ? 'unavailable' : 'idle',
  );
  const [problem, setProblem] = useState<Error | null>(null);

  const stop = () => {
    for (const t of stream.current?.getTracks() ?? []) t.stop();
    stream.current = null;
  };
  // The camera is released when this tab closes or the dialog goes away.
  useEffect(
    () => () => {
      for (const t of stream.current?.getTracks() ?? []) t.stop();
      stream.current = null;
    },
    [],
  );

  const start = async () => {
    setState('starting');
    setProblem(null);
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } },
        audio: false,
      });
      stream.current = s;
      setState('live');
      requestAnimationFrame(() => {
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play().catch(() => undefined);
        }
      });
    } catch (e) {
      const denied =
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setProblem(
        new Error(
          denied
            ? 'The camera is blocked for this site. Allow it in your browser, or use your phone camera below.'
            : 'No camera could be started. Use your phone camera or upload a picture instead.',
        ),
      );
      setState('unavailable');
    }
  };

  const shoot = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')?.drawImage(v, 0, 0);
    stop();
    onPhoto(await loadImage(c.toDataURL('image/png')));
  };

  return (
    <div className="flex flex-col items-center gap-3" data-testid="camera-capture">
      {state === 'live' && (
        <>
          <div className="relative size-64 overflow-hidden rounded-card bg-sunken">
            {/* biome-ignore lint/a11y/useMediaCaption: a live camera preview has no audio or captions */}
            <video
              ref={video}
              muted
              playsInline
              aria-label="Camera preview"
              className="size-full -scale-x-100 object-cover"
            />
          </div>
          <Button variant="primary" onClick={() => void shoot()} data-testid="camera-shoot">
            <Camera aria-hidden="true" className="size-4" />
            Take photo
          </Button>
        </>
      )}
      {state !== 'live' && (
        <div className="flex size-64 flex-col items-center justify-center gap-3 rounded-card border border-dashed border-control bg-sunken px-4 text-center text-sm text-muted">
          <Camera aria-hidden="true" className="size-8 text-subtle" />
          {state === 'unavailable'
            ? 'The camera is not available here.'
            : 'Use your camera to take a new picture.'}
          {state !== 'unavailable' && (
            <Button
              variant="primary"
              loading={state === 'starting'}
              onClick={() => void start()}
              data-testid="camera-start"
            >
              Start camera
            </Button>
          )}
        </div>
      )}
      <ErrorBox error={problem} />
      <label className="inline-flex cursor-pointer items-center gap-2 rounded-control border border-control bg-surface px-3 py-2 text-sm font-medium text-fg hover:bg-sunken focus-within:ring-2 focus-within:ring-ring/50 [@media(pointer:coarse)]:min-h-11">
        <Upload aria-hidden="true" className="size-4" />
        Use your phone camera
        <input
          type="file"
          accept="image/*"
          capture="user"
          className="sr-only"
          data-testid="camera-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = '';
          }}
        />
      </label>
    </div>
  );
}
