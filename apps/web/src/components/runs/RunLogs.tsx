import { useEffect, useRef, useState } from 'react';
import { getSocket } from '../../ws/socket.ts';
import { Select } from '../ui.tsx';

const MAX_LINES = 500;

/**
 * Live log tail of a run environment: while this is open the browser follows the environment, so the runner sends the
 * buffered tail and then new lines. Nothing is stored on the server; closing it stops the stream.
 */
export function RunLogs({ envId, services }: { envId: string; services: string[] }) {
  const [lines, setLines] = useState<Record<string, string[]>>({});
  const [service, setService] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const sock = getSocket();
    if (!sock) return;
    return sock.watchRun(envId, (name, batch, history) =>
      setLines((cur) => ({
        ...cur,
        [name]: history ? batch.slice(-MAX_LINES) : [...(cur[name] ?? []), ...batch].slice(-MAX_LINES),
      })),
    );
  }, [envId]);

  const names = [...new Set([...services, ...Object.keys(lines)])];
  const current = service && names.includes(service) ? service : (names[0] ?? '');
  const shown = lines[current] ?? [];

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the end whenever lines arrive
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown.length, current]);

  return (
    <div className="flex flex-col gap-2" data-testid="run-logs">
      {names.length > 1 && (
        <Select
          label="Service"
          value={current}
          onChange={(e) => setService(e.target.value)}
          data-testid="run-logs-service"
        >
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      )}
      <textarea
        ref={box}
        readOnly
        aria-label={current ? `Log of ${current}` : 'Log'}
        className="max-h-72 min-h-24 w-full resize-y overflow-auto rounded-control border border-line bg-sunken p-2 font-mono text-xs leading-5 whitespace-pre text-fg"
        data-testid="run-log-lines"
        rows={10}
        value={shown.length ? shown.join('\n') : 'No output yet.'}
      />
    </div>
  );
}
