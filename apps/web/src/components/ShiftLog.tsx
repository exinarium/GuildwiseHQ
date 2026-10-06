import type { ProgressItem, ShiftDto } from '@aom/shared';
import { useEffect, useRef, useState } from 'react';
import { getSocket } from '../ws/socket.ts';

/** Live shift log: seeded with `progressTail`, then appended via `shift.watch` / `shift.progress`. */
export function ShiftLog({ shift }: { shift: ShiftDto }) {
  const [items, setItems] = useState<ProgressItem[]>(shift.progressTail);
  const box = useRef<HTMLDivElement>(null);
  const shiftId = shift.id;

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    return sock.watchShift(shiftId, (batch) =>
      setItems((cur) => {
        const seen = new Set(cur.map((i) => `${i.at}|${i.text}`));
        return [...cur, ...batch.filter((i) => !seen.has(`${i.at}|${i.text}`))].slice(-200);
      }),
    );
  }, [shiftId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on every new batch
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [items.length]);

  return (
    <div
      ref={box}
      role="log"
      aria-label="Live shift log"
      aria-live="polite"
      data-testid="shift-log"
      className="max-h-64 overflow-y-auto rounded-control bg-side p-2 font-mono text-xs leading-relaxed text-side-fg"
    >
      {items.length === 0 && <p className="text-side-label">Waiting for output...</p>}
      {items.map((i) => (
        <p
          key={`${i.at}|${i.text}`}
          className={i.kind === 'tool' ? 'text-[#8fc7ff]' : i.kind === 'status' ? 'text-[#f2b544]' : ''}
        >
          <span className="text-side-label">{new Date(i.at).toLocaleTimeString()} </span>
          {i.text}
        </p>
      ))}
    </div>
  );
}
