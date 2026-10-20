import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { type ChatSegment, groupSegments, liveStatus, segmentsText } from '../../lib/chatSegments.ts';
import { AgentAvatar } from '../Face.tsx';
import { CopyButton, Markdown } from './Markdown.tsx';
import { ToolGroup } from './ToolRow.tsx';

/** Seconds since `startedAt` (ms), ticking once a second while `active`. */
export function useElapsed(active: boolean, startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

export function formatElapsed(s: number): string {
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "Thinking…" with an elapsed time while a turn is running. */
export function LiveStatus({ segments, startedAt }: { segments: ChatSegment[]; startedAt: number }) {
  const elapsed = useElapsed(true, startedAt);
  return (
    <p
      role="status"
      data-testid="chat-live-status"
      className="flex min-w-0 items-center gap-2 text-sm text-muted"
    >
      <Loader2 aria-hidden="true" className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 truncate">{liveStatus(segments)}</span>
      <span className="tnum shrink-0 text-xs text-subtle">{formatElapsed(elapsed)}</span>
    </p>
  );
}

/**
 * One agent turn, full width like Claude Code: avatar and name, then the timeline of text and tool rows. Without segments
 * (old messages, old runner) the `body` is rendered as markdown.
 */
export function AgentTurn({
  name,
  agentId,
  body,
  segments,
  at,
  model,
  live,
  testId = 'chat-message',
  ...rest
}: {
  name: string;
  agentId?: string | null | undefined;
  body: string;
  segments?: ChatSegment[] | null | undefined;
  /** ISO time of the stored message. */
  at?: string;
  /** The model that answered (CEO). */
  model?: string | null;
  /** Streaming: the live status line is shown under the turn. */
  live?: { startedAt: number } | undefined;
  testId?: string;
} & Record<string, unknown>) {
  const items = segments && segments.length > 0 ? groupSegments(segments) : null;
  const hasText = items ? items.some((i) => i.kind === 'text') : body.trim().length > 0;
  const copyText = segments && segments.length > 0 ? segmentsText(segments) || body : body;
  return (
    <li
      data-testid={testId}
      data-author-kind="agent"
      className="group flex w-full min-w-0 flex-col gap-1.5 self-stretch"
      {...rest}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-fg">
        <AgentAvatar agentId={agentId ?? null} name={name} size={22} />
        <span className="truncate">{name}</span>
        {model && (
          <span
            className="rounded-full bg-sunken px-2 py-px text-[11px] font-normal text-subtle"
            data-testid="answered-with"
          >
            {model}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2 pl-0 text-fg md:pl-7">
        {items ? (
          items.map((it) =>
            it.kind === 'text' ? (
              <Markdown key={it.key} text={it.text} />
            ) : (
              <ToolGroup key={it.key} tools={it.tools} />
            ),
          )
        ) : hasText ? (
          <Markdown text={body} />
        ) : null}
        {live && <LiveStatus segments={segments ?? []} startedAt={live.startedAt} />}
      </div>
      {!live && (
        <div className="flex items-center gap-1 pl-0 text-xs text-subtle md:pl-7 md:opacity-0 md:transition-opacity md:group-focus-within:opacity-100 md:group-hover:opacity-100">
          {at && <time dateTime={at}>{formatClock(at)}</time>}
          {hasText && <CopyButton text={copyText} label="Copy message" className="size-9 md:size-7" />}
        </div>
      )}
    </li>
  );
}

/** A compact right-aligned bubble for what the user said (whitespace kept). */
export function UserBubble({
  body,
  at,
  queued,
  testId = 'chat-message',
}: {
  body: string;
  at?: string;
  queued?: boolean;
  testId?: string;
}) {
  return (
    <li
      data-testid={testId}
      data-author-kind="user"
      className="group flex max-w-[88%] flex-col items-end gap-0.5 self-end md:max-w-[75%]"
    >
      <p className="rounded-[18px] rounded-br-[6px] bg-brand px-3.5 py-2 text-base whitespace-pre-wrap text-brand-fg [overflow-wrap:anywhere]">
        {body}
      </p>
      <span className="flex items-center gap-1.5 text-[11px] text-subtle md:opacity-0 md:transition-opacity md:group-hover:opacity-100">
        {queued && <span>Queued</span>}
        {at && <time dateTime={at}>{formatClock(at)}</time>}
        <CopyButton text={body} label="Copy message" className="size-7" />
      </span>
    </li>
  );
}
