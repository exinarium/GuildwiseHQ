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
      className="max-h-64 overflow-y-auto rounded-md bg-zinc-950 p-2 font-mono text-xs leading-relaxed text-zinc-200"
    >
      {items.length === 0 && <p className="text-zinc-500">Waiting for output...</p>}
      {items.map((i) => (
        <p
          key={`${i.at}|${i.text}`}
          className={i.kind === 'tool' ? 'text-sky-300' : i.kind === 'status' ? 'text-amber-300' : ''}
        >
          <span className="text-zinc-500">{new Date(i.at).toLocaleTimeString()} </span>
          {i.text}
        </p>
      ))}
    </div>
  );
}
