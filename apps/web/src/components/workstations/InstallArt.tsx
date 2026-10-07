import type { GuideStep } from '../../lib/installer-guide.ts';

/**
 * Small line illustrations for the install steps. They draw with the design tokens (stroke: `currentColor`, fills from
 * the surface tokens) so they follow light and dark, and carry no meaning on their own (each step has its text).
 */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 96 64"
      aria-hidden="true"
      className="h-16 w-24 shrink-0 text-brand-text"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const Window = () => (
  <>
    <rect x="6" y="6" width="84" height="52" rx="6" className="fill-sunken" {...stroke} />
    <path d="M6 18h84" {...stroke} />
    <circle cx="14" cy="12" r="1.6" fill="currentColor" />
    <circle cx="21" cy="12" r="1.6" fill="currentColor" />
    <circle cx="28" cy="12" r="1.6" fill="currentColor" />
  </>
);

export function InstallArt({ kind }: { kind: GuideStep['art'] }) {
  switch (kind) {
    case 'terminal':
      return (
        <Frame>
          <Window />
          <path d="M16 30l8 6-8 6" {...stroke} />
          <path d="M30 42h20" {...stroke} />
        </Frame>
      );
    case 'paste':
      return (
        <Frame>
          <Window />
          <path d="M14 32h44" {...stroke} />
          <path d="M14 42h30" {...stroke} />
          <rect x="62" y="30" width="22" height="24" rx="3" className="fill-surface" {...stroke} />
          <path d="M68 30v-3h10v3" {...stroke} />
          <path d="M67 40h12M67 46h8" {...stroke} />
        </Frame>
      );
    case 'shield':
      return (
        <Frame>
          <path d="M48 8l26 9v17c0 14-11 22-26 26-15-4-26-12-26-26V17z" className="fill-sunken" {...stroke} />
          <path d="M37 33l8 8 14-16" {...stroke} />
        </Frame>
      );
    case 'restart':
      return (
        <Frame>
          <path d="M70 24a24 24 0 1 0 2 14" {...stroke} />
          <path d="M72 10v16H56" {...stroke} />
          <path d="M44 28v14l10-7z" fill="currentColor" stroke="none" />
        </Frame>
      );
    case 'user':
      return (
        <Frame>
          <circle cx="48" cy="22" r="11" className="fill-sunken" {...stroke} />
          <path d="M24 56c2-14 12-20 24-20s22 6 24 20" className="fill-sunken" {...stroke} />
          <path d="M70 14v12M64 20h12" {...stroke} />
        </Frame>
      );
    case 'login':
      return (
        <Frame>
          <rect x="24" y="26" width="48" height="30" rx="5" className="fill-sunken" {...stroke} />
          <path d="M34 26v-6a14 14 0 0 1 28 0v6" {...stroke} />
          <circle cx="48" cy="40" r="3.5" fill="currentColor" />
          <path d="M48 43v6" {...stroke} />
        </Frame>
      );
    case 'done':
      return (
        <Frame>
          <circle
            cx="48"
            cy="32"
            r="22"
            className="fill-success-soft"
            stroke="currentColor"
            strokeWidth={2}
          />
          <path d="M37 33l8 8 15-17" {...stroke} />
        </Frame>
      );
  }
}
